const BaseGrocyNode = require('./lib/base-node');
const GrocyClient = require('./lib/grocy-client');
const OperationRouter = require('./lib/operation-router');
const Validators = require('./lib/validators');
const ErrorHandler = require('./lib/error-handler');

module.exports = function (RED) {
  /**
   * Grocy API Node using modular architecture
   */
  function GrocyApiNode(config) {
    const baseNode = new BaseGrocyNode(RED, this, config);
    
    // Copy base node properties and methods to this instance
    Object.assign(this, baseNode);
    
    // Initialize Node-RED node
    RED.nodes.createNode(this, config);
    
    // Set node-specific properties
    this.operation = config.operation;
    this.entityType = config.entityType;
    
    // Initialize base functionality
    this.initialize();
    
    // Initialize router after base setup
    if (this.client) {
      this.router = new OperationRouter(this.client);
    }
    // Override processMessage method
    this.processMessage = async (msg) => {
      // Validate inputs
      const operation = this.getOperation(msg);
      const payload = this.getPayload(msg);
      const options = this.getOptions(msg);
      const entityType = this.getEntityType(msg);

      // Validate operation
      Validators.validateOperation(operation);

      if (!this.router) {
        throw ErrorHandler.operationError('Router not initialized - client unavailable');
      }

      if (!this.router.isSupported(operation)) {
        throw ErrorHandler.operationError(operation);
      }

      // Debug logging
      this.debug('Executing operation', {
        operation,
        category: this.router.getOperationCategory(operation),
        entityType,
        hasPayload: !!Object.keys(payload).length,
        hasOptions: !!Object.keys(options).length
      });

      // Execute operation through router
      try {
        const result = await this.router.execute(operation, payload, options, entityType);

        this.debug('Operation completed successfully', {
          operation,
          resultType: typeof result,
          isArray: Array.isArray(result)
        });

        return result;
      } catch (error) {
        const connInfo = this.client ? this.client.getConnectionInfo() : {};
        const category = this.router.getOperationCategory(operation);

        const requestLines = [
          `Operation : ${operation}`,
          `Category  : ${category || 'unknown'}`,
          entityType            ? `Entity    : ${entityType}` : null,
          connInfo.apiUrl       ? `URL       : ${connInfo.apiUrl}` : null,
          `Auth      : GROCY-API-KEY [redacted]`,
          `Headers   : { "Content-Type": "application/json" }`,
          `Body      : ${Object.keys(payload).length ? JSON.stringify(payload, null, 2) : '(empty)'}`,
          Object.keys(options).length ? `Options   : ${JSON.stringify(options)}` : null,
        ].filter(Boolean).join('\n');

        const wrapped = new Error(
          `${error.message}\n\n--- Request Details ---\n${requestLines}`
        );
        wrapped.cause = error;
        wrapped.operation = operation;
        wrapped.category = category;
        wrapped.requestDetails = { operation, category, entityType, payload, options };
        throw wrapped;
      }
    };

    // Add utility methods
    this.getOperationStats = () => {
      return this.router ? this.router.getStatistics() : null;
    };

    this.supportsOperation = (operation) => {
      return this.router ? this.router.isSupported(operation) : false;
    };
  }

  // Register the node with Node-RED
  RED.nodes.registerType('grocy-api', GrocyApiNode, {
    credentials: {
      apiKey: { type: 'password' },
    },
  });
};
