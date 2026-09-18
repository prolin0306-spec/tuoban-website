'use strict';
const cloudbase = require('@cloudbase/node-sdk');
const { createRepository } = require('./repository');
const { createService } = require('./service');
// Only deploy as a CloudBase SDK-callable function. No unauthenticated HTTP route.
exports.main = async event => {
  const context = cloudbase.getCloudbaseContext();
  const actualEnv = context.TCB_ENV || context.SCF_NAMESPACE;
  const expectedEnv = process.env.WEB_HOMEWORK_ENV_ID;
  if (!expectedEnv || actualEnv !== expectedEnv) return { code: 'NOT_CONFIGURED', message: '后端环境尚未正确配置' };
  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
  return createService({
    repo: createRepository(app.database()), environmentId: actualEnv,
    identity: async () => {
      // No UID argument: this reads the SDK gateway's trusted invocation context.
      const result = await app.auth().getEndUserInfo();
      const user = result && result.userInfo;
      return user && { uid: user.uid, isAnonymous: user.isAnonymous };
    }
  })(event);
};
