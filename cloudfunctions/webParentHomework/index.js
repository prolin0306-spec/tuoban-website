'use strict';
const cloudbase = require('@cloudbase/node-sdk');
const { createRepository } = require('./repository');
const { createService } = require('./service');
exports.main = async event => {
  const context = cloudbase.getCloudbaseContext();
  const actualEnv = context.TCB_ENV || context.SCF_NAMESPACE;
  if (!process.env.WEB_PARENT_HOMEWORK_ENV_ID || actualEnv !== process.env.WEB_PARENT_HOMEWORK_ENV_ID) {
    return { code: 'NOT_CONFIGURED', message: '后端环境尚未正确配置' };
  }
  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
  return createService({ repo: createRepository(app.database()), identity: async () => {
    const result = await app.auth().getEndUserInfo();
    return result && result.userInfo && { uid: result.userInfo.uid };
  } })(event);
};
