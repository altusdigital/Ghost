const ParentRouter = require('./parent-router');
const emailOpenController = require('./controllers/email-open');

class EmailOpenRouter extends ParentRouter {
  constructor() {
    super('EmailOpenRouter');
    this.route = { value: '/email/open/' };
    this.mountRoute(this.route.value, emailOpenController);
  }
}

module.exports = EmailOpenRouter;
