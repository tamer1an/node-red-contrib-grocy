const customFetch = require('./custom-fetch');
const { createLogger, generateCorrelationId } = require('./logging');

/**
 * Wrapper around node-grocy API that adds SSL verification support.
 * This extends the base Grocy API class to use our custom fetch implementation
 * that supports self-hosted deployment patterns.
 */
class GrocyAPIWrapper {
    constructor(baseUrl, apiKey, sslOptions = {}, loggingConfig = {}) {
        this.baseUrl = baseUrl.endsWith('/api') ? baseUrl : `${baseUrl}/api`;
        this.apiKey = apiKey;
        this.sslOptions = {
            verifySsl: sslOptions.verifySsl !== false,
            allowSelfSigned: sslOptions.allowSelfSigned === true,
            timeout: sslOptions.timeout || 30000
        };
        
        // Initialize logger if config provided
        this.logger = loggingConfig.enabled !== false ? createLogger({
            id: loggingConfig.nodeId || 'grocy-api-wrapper',
            type: 'api-wrapper',
            ...loggingConfig
        }) : null;
    }
    
    /**
     * Make a request to the Grocy API with SSL options
     */
    async request(endpoint, method = 'GET', data = null, queryParams = {}, correlationId = null) {
        if (!this.apiKey) {
            throw new Error('API key is required');
        }
        
        // Generate correlation ID if not provided
        const cid = correlationId || (this.logger ? generateCorrelationId() : null);
        
        const url = new URL(`${this.baseUrl}${endpoint}`);
        
        // Add query parameters
        if (queryParams && Object.keys(queryParams).length > 0) {
            Object.entries(queryParams).forEach(([key, value]) => {
                if (Array.isArray(value)) {
                    value.forEach((v) => url.searchParams.append(`${key}[]`, v));
                } else if (value !== undefined && value !== null) {
                    url.searchParams.append(key, value.toString());
                }
            });
        }
        
        const hasBody = data !== null && (method === 'POST' || method === 'PUT');

        const options = {
            method,
            headers: {
                'GROCY-API-KEY': this.apiKey,
                ...(hasBody ? { 'Content-Type': 'application/json' } : {})
            },
            verifySsl: this.sslOptions.verifySsl,
            allowSelfSigned: this.sslOptions.allowSelfSigned,
            timeout: this.sslOptions.timeout
        };

        // Add correlation ID header if available
        if (cid) {
            options.headers['X-Correlation-ID'] = cid;
        }

        if (hasBody) {
            options.body = JSON.stringify(data);
        }
        
        // Log request if logger is available
        let requestContext = null;
        if (this.logger) {
            requestContext = this.logger.logRequest(method, endpoint, {
                url: url.toString(),
                hasData: !!data,
                queryParamCount: Object.keys(queryParams).length
            }, cid);
        }
        
        try {
            const response = await customFetch(url.toString(), options);
            
            // Handle non-JSON responses
            if (response.status === 204) {
                // Log successful response
                if (this.logger && requestContext) {
                    this.logger.logResponse(requestContext, 204, { noContent: true });
                }
                return { success: true };
            }
            
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                const jsonData = await response.json();
                
                if (!response.ok) {
                    const error = new Error(jsonData.error_message || `HTTP error! status: ${response.status}`);
                    // Log error response
                    if (this.logger && requestContext) {
                        this.logger.logResponse(requestContext, response.status, {
                            error: jsonData.error_message
                        }, error);
                    }
                    throw error;
                }
                
                // Log successful response
                if (this.logger && requestContext) {
                    this.logger.logResponse(requestContext, response.status, {
                        hasData: true,
                        dataType: typeof jsonData
                    });
                }
                
                return jsonData;
            } else if (response.ok) {
                // Log successful non-JSON response
                if (this.logger && requestContext) {
                    this.logger.logResponse(requestContext, response.status, {
                        contentType: contentType || 'unknown'
                    });
                }
                return { success: true };
            }
            
            const error = new Error(`HTTP error! status: ${response.status}`);
            // Log error response
            if (this.logger && requestContext) {
                this.logger.logResponse(requestContext, response.status, {}, error);
            }
            throw error;
        } catch (error) {
            // Log error if we haven't already
            if (this.logger && requestContext && !error.logged) {
                this.logger.logResponse(requestContext, 0, {
                    errorType: error.constructor.name,
                    errorCode: error.code
                }, error);
            }
            
            // Enhance error messages for common failure modes
            const cause = error.cause || error;
            const code = cause.code || error.code;

            if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
                throw new Error(
                    `Cannot reach Grocy at ${this.baseUrl}: hostname not found (${code}). ` +
                    'Check that the API URL is correct and reachable from this machine.'
                );
            } else if (code === 'ECONNREFUSED') {
                throw new Error(
                    `Connection refused to ${this.baseUrl}. ` +
                    'Grocy may not be running or the port/URL is wrong.'
                );
            } else if (code === 'ECONNRESET' || code === 'ETIMEDOUT') {
                throw new Error(
                    `Connection to ${this.baseUrl} timed out or was reset (${code}). ` +
                    'Check network connectivity and the timeout setting.'
                );
            } else if (error.message.includes('self-signed')) {
                throw new Error(
                    'SSL Error: ' + error.message + '\n' +
                    'Solution: Enable "Allow self-signed certificates" in the Grocy configuration node.'
                );
            } else if (error.message.includes('certificate')) {
                throw new Error(
                    'SSL Error: ' + error.message + '\n' +
                    'Solution: Check SSL settings in the Grocy configuration node.'
                );
            } else if (error.message === 'fetch failed' || error.message.includes('fetch failed')) {
                throw new Error(
                    `Network request to ${this.baseUrl} failed. ` +
                    'Verify the API URL is reachable from the Node-RED server ' +
                    '(not just from your browser). Cause: ' + (cause.message || error.message)
                );
            }
            throw error;
        }
    }
    
    async getSystemInfo() {
        return this.request('/system/info');
    }
    
    async testConnection() {
        try {
            const info = await this.getSystemInfo();
            return { success: true, systemInfo: info };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    
    // Stock methods
    async getStock() {
        return this.request('/stock');
    }

    async getStockByProductId(productId) {
        return this.request(`/stock/products/${productId}`);
    }
    
    // Shopping list methods
    async getShoppingList() {
        return this.request('/objects/shopping_list');
    }

    async addToShoppingList(productId, amount, note) {
        return this.request('/shoppinglist/add-product', 'POST', { product_id: productId, amount, note });
    }

    async addProductToShoppingList(data) {
        return this.request('/shoppinglist/add-product', 'POST', data);
    }

    async removeProductFromShoppingList(data) {
        return this.request('/shoppinglist/remove-product', 'POST', data);
    }

    async clearShoppingList(data = {}) {
        return this.request('/shoppinglist/clear', 'POST', data);
    }

    async addMissingProductsToShoppingList(data = {}) {
        return this.request('/shoppinglist/add-missing-products', 'POST', data);
    }

    async addOverdueProductsToShoppingList(data = {}) {
        return this.request('/shoppinglist/add-overdue-products', 'POST', data);
    }

    async addExpiredProductsToShoppingList(data = {}) {
        return this.request('/shoppinglist/add-expired-products', 'POST', data);
    }

    // Stock action methods
    async getVolatileStock(dueSoonDays) {
        const params = dueSoonDays !== undefined ? { due_soon_days: dueSoonDays } : {};
        return this.request('/stock/volatile', 'GET', null, params);
    }

    async getProductDetails(productId) {
        return this.request(`/stock/products/${productId}`);
    }

    async getProductByBarcode(barcode) {
        return this.request(`/stock/products/by-barcode/${encodeURIComponent(barcode)}`);
    }

    async addProductToStock(productId, data = {}) {
        return this.request(`/stock/products/${productId}/add`, 'POST', data);
    }

    async addProductToStockByBarcode(barcode, data = {}) {
        return this.request(`/stock/products/by-barcode/${encodeURIComponent(barcode)}/add`, 'POST', data);
    }

    async consumeProduct(productId, data = {}) {
        return this.request(`/stock/products/${productId}/consume`, 'POST', data);
    }

    async consumeProductByBarcode(barcode, data = {}) {
        return this.request(`/stock/products/by-barcode/${encodeURIComponent(barcode)}/consume`, 'POST', data);
    }

    async inventoryProduct(productId, data = {}) {
        return this.request(`/stock/products/${productId}/inventory`, 'POST', data);
    }

    async transferProduct(productId, data = {}) {
        return this.request(`/stock/products/${productId}/transfer`, 'POST', data);
    }

    async openProduct(productId, data = {}) {
        return this.request(`/stock/products/${productId}/open`, 'POST', data);
    }

    // Chores methods
    async getChores(queryOptions = {}) {
        return this.request('/chores', 'GET', null, queryOptions);
    }

    async getChore(choreId) {
        return this.request(`/chores/${choreId}`);
    }

    async getChoreDetails(choreId) {
        return this.request(`/chores/${choreId}`);
    }

    async executeChore(choreId, data = {}) {
        return this.request(`/chores/${choreId}/execute`, 'POST', data);
    }

    // Task methods
    async getTasks(queryOptions = {}) {
        return this.request('/tasks', 'GET', null, queryOptions);
    }

    async completeTask(taskId, data = {}) {
        return this.request(`/tasks/${taskId}/complete`, 'POST', data);
    }

    async undoTask(taskId) {
        return this.request(`/tasks/${taskId}/undo`, 'POST');
    }

    // Battery methods
    async getBatteries(queryOptions = {}) {
        return this.request('/batteries', 'GET', null, queryOptions);
    }

    async getBattery(batteryId) {
        return this.request(`/batteries/${batteryId}`);
    }

    async getBatteryDetails(batteryId) {
        return this.request(`/batteries/${batteryId}`);
    }

    async chargeBattery(batteryId, data = {}) {
        return this.request(`/batteries/${batteryId}/charge`, 'POST', data);
    }

    // Generic entity methods
    async getObjects(entity, queryOptions = {}) {
        return this.request(`/objects/${entity}`, 'GET', null, queryOptions);
    }

    async getObject(entity, objectId) {
        return this.request(`/objects/${entity}/${objectId}`);
    }

    async createObject(entity, data) {
        return this.request(`/objects/${entity}`, 'POST', data);
    }

    async addObject(entity, data) {
        return this.createObject(entity, data);
    }

    async editObject(entity, objectId, data) {
        return this.request(`/objects/${entity}/${objectId}`, 'PUT', data);
    }

    async deleteObject(entity, objectId) {
        return this.request(`/objects/${entity}/${objectId}`, 'DELETE');
    }

    async getUserfields(entity, objectId) {
        return this.request(`/objects/${entity}/${objectId}/userfields`);
    }

    async setUserfields(entity, objectId, data) {
        return this.request(`/userfields/${entity}/${objectId}`, 'PUT', data);
    }

    // Recipe methods
    async getRecipes(queryOptions = {}) {
        return this.request('/recipes', 'GET', null, queryOptions);
    }

    async getRecipeFulfillment(recipeId) {
        return this.request(`/recipes/${recipeId}/fulfillment`);
    }

    async consumeRecipe(recipeId) {
        return this.request(`/recipes/${recipeId}/consume`, 'POST');
    }

    async getAllRecipesFulfillment(queryOptions = {}) {
        return this.request('/recipes/fulfillment', 'GET', null, queryOptions);
    }

    async addRecipeProductsToShoppingList(recipeId, data = {}) {
        return this.request(`/recipes/${recipeId}/add-products-to-shoppinglist`, 'POST', data);
    }

    // User methods
    async getUsers(queryOptions = {}) {
        return this.request('/users', 'GET', null, queryOptions);
    }

    async createUser(data) {
        return this.request('/users', 'POST', data);
    }

    async editUser(userId, data) {
        return this.request(`/users/${userId}`, 'PUT', data);
    }

    async deleteUser(userId) {
        return this.request(`/users/${userId}`, 'DELETE');
    }

    async getCurrentUser() {
        return this.request('/user/settings');
    }

    // System methods
    async getDbChangedTime() {
        return this.request('/system/db-changed-time');
    }

    async getConfig() {
        return this.request('/system/config');
    }

    async getTime(offset) {
        return this.request('/system/time', 'GET', null, offset !== undefined ? { offset } : {});
    }

    // User settings methods
    async getUserSettings() {
        return this.request('/user/settings');
    }

    async getUserSetting(settingKey) {
        return this.request(`/user/settings/${settingKey}`);
    }

    async setUserSetting(settingKey, data) {
        return this.request(`/user/settings/${settingKey}`, 'PUT', data);
    }

    // File methods
    async getFile(group, fileName) {
        return this.request(`/files/${group}/${encodeURIComponent(fileName)}`);
    }

    async uploadFile(group, fileName, fileData) {
        return this.request(`/files/${group}/${encodeURIComponent(fileName)}`, 'PUT', fileData);
    }

    async deleteFile(group, fileName) {
        return this.request(`/files/${group}/${encodeURIComponent(fileName)}`, 'DELETE');
    }

    // Calendar methods
    async getCalendar() {
        return this.request('/calendar/ical');
    }

    async getCalendarSharingLink() {
        return this.request('/calendar/ical/sharing-link');
    }
}

module.exports = GrocyAPIWrapper;