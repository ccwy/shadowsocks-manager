const log4js = require('log4js');
const logger = log4js.getLogger('account');
const knex = appRequire('init/knex').knex;
const serverManager = appRequire('plugins/flowSaver/server');
const flow = appRequire('plugins/flowSaver/flow');
const manager = appRequire('services/manager');
const moment = require('moment');
const cron = appRequire('init/cron');
let messages = [];

const sendMessage = () => {
  if(!messages.length) {
    return;
  }
  messages.forEach(message => {
    manager.send(message[0], message[1]).then().catch();
  });
  messages = [];
};

cron.second(() => {
  sendMessage();
}, 10);

const addPort = (data, server) => {
  messages.push([{
    command: 'add',
    port: data.port,
    password: data.password,
  }, {
    host: server.host,
    port: server.port,
    password: server.password,
  }]);
};

const delPort = (data, server) => {
  messages.push([{
    command: 'del',
    port: data.port,
  }, {
    host: server.host,
    port: server.port,
    password: server.password,
  }]);
};

const changePassword = async (id, password) => {
  const server = await serverManager.list();
  const account = await knex('account_plugin').select();
  const port = account.filter(f => f.id === id)[0].port;
  if(!port) { return Promise.reject('account id not exists'); }
  server.forEach(s => {
    messages.push([{
      command: 'pwd',
      port,
      password,
    }, {
      host: s.host,
      port: s.port,
      password: s.password,
    }]);
  });
  return;
};

const checkFlow = async (server, port, startTime, endTime) => {
  let isMultiServerFlow = false;
  try {
    isMultiServerFlow = await knex('webguiSetting').select().
    where({ key: 'account' })
    .then(success => {
      if(!success.length) {
        return Promise.reject('settings not found');
      }
      success[0].value = JSON.parse(success[0].value);
      return success[0].value.multiServerFlow;
    });
  } catch (err) {}
  const serverId = isMultiServerFlow ? null : server;
  const userFlow = await flow.getFlowFromSplitTime(serverId, port, startTime, endTime);
  return userFlow;
};

const checkAccountTime = {};

const deleteCheckAccountTimePort = port => {
  const reg = new RegExp('^\d{1,3}\|' + port + '$');
  for(cat in checkAccountTime) {
    if(cat.match(reg)) {
      delete checkAccountTime[cat];
    }
  }
};
const deleteCheckAccountTimeServer = Server => {
  const reg = new RegExp('^' + Server + '\|\d{1,5}$');
  for(cat in checkAccountTime) {
    if(cat.match(reg)) {
      delete checkAccountTime[cat];
    }
  }
};

let lastCheck = 0;
const checkServer = async () => {
  if(!lastCheck) {
    lastCheck = Date.now();
  } else if(Date.now() - lastCheck <= 29 * 1000) {
    return;
  }
  lastCheck = Date.now();
  logger.info('check account');
  const account = await knex('account_plugin').select();
  account.forEach(a => {
    if(a.type >= 2 && a.type <= 5) {
      let timePeriod = 0;
      if(a.type === 2) { timePeriod = 7 * 86400 * 1000; }
      if(a.type === 3) { timePeriod = 30 * 86400 * 1000; }
      if(a.type === 4) { timePeriod = 1 * 86400 * 1000; }
      if(a.type === 5) { timePeriod = 3600 * 1000; }
      const data = JSON.parse(a.data);
      let startTime = data.create;
      while(startTime + timePeriod <= Date.now()) {
        startTime += timePeriod;
      }
      if(data.create + data.limit * timePeriod <= Date.now() || data.create >= Date.now()) {
        if(a.autoRemove) {
          knex('account_plugin').delete().where({ id: a.id }).then();
        }
      }
    }
  });
  const server = await serverManager.list();
  account.exist = number => {
    return !!account.filter(f => f.port === number)[0];
  };
  let isMultiServerFlow = false;
  try {
    isMultiServerFlow = await knex('webguiSetting').select().
    where({ key: 'account' })
    .then(success => {
      if(!success.length) {
        return Promise.reject('settings not found');
      }
      success[0].value = JSON.parse(success[0].value);
      return success[0].value.multiServerFlow;
    });
  } catch (err) {}
  const promises = [];
  server.forEach(s => {
    const checkServerAccount = async s => {
      try {
        const port = await manager.send({ command: 'list' }, {
          host: s.host,
          port: s.port,
          password: s.password,
        });
        port.list = {};
        port.forEach(f => {
          port.list[f.port] = true;
        });
        port.exist = number => {
          return !!port.list[number];
        };
        const checkAccountStatus = async a => {
          const accountServer = a.server ? JSON.parse(a.server) : a.server;
          if(accountServer) {
            const newAccountServer = accountServer.filter(f => {
              return server.filter(sf => sf.id === f)[0];
            });
            if(JSON.stringify(newAccountServer) !== JSON.stringify(accountServer)) {
              await knex('account_plugin').update({
                server: JSON.stringify(newAccountServer),
              }).where({
                port: a.port,
              });
            }
          }
          if(accountServer && accountServer.indexOf(s.id) < 0) {
            port.exist(a.port) && delPort(a, s);
            return 0;
          }
          if(a.type >= 2 && a.type <= 5) {
            let timePeriod = 0;
            if(a.type === 2) { timePeriod = 7 * 86400 * 1000; }
            if(a.type === 3) { timePeriod = 30 * 86400 * 1000; }
            if(a.type === 4) { timePeriod = 1 * 86400 * 1000; }
            if(a.type === 5) { timePeriod = 3600 * 1000; }
            const data = JSON.parse(a.data);
            let startTime = data.create;
            while(startTime + timePeriod <= Date.now()) {
              startTime += timePeriod;
            }
            let flow = -1;
            if(!checkAccountTime['' + s.id + '|' + a.port] || (checkAccountTime['' + s.id + '|' + a.port] && Date.now() >= checkAccountTime['' + s.id + '|' + a.port])) {
              flow = await checkFlow(s.id, a.port, startTime, Date.now());
              const nextTime = (data.flow * (isMultiServerFlow ? 1 : s.scale) - flow) / 200000000 * 60 * 1000;
              if(nextTime <= 0) {
                checkAccountTime['' + s.id + '|' + a.port] = Date.now() + 10 * 60 * 1000;
              } else {
                checkAccountTime['' + s.id + '|' + a.port] = Date.now() + nextTime;
              }
            }
            if(flow >= 0 && isMultiServerFlow && flow >= data.flow) {
              port.exist(a.port) && delPort(a, s);
              return 1;
            } else if (flow >= 0 && !isMultiServerFlow && flow >= data.flow * s.scale) {
              port.exist(a.port) && delPort(a, s);
              return 1;
            } else if(data.create + data.limit * timePeriod <= Date.now() || data.create >= Date.now()) {
              port.exist(a.port) && delPort(a, s);
              return 0;
            } else if(!port.exist(a.port) && flow >= 0) {
              addPort(a, s);
              return 0;
            } else {
              return flow >= 0 ? 1 : 0;
            }
          } else if (a.type === 1) {
            if(port.exist(a.port)) {
              return 0;
            }
            addPort(a, s);
            return 0;
          } else {
            return 0;
          }
        };
        const checkAccountStatusPromises = [];
        account.forEach(a => {
          checkAccountStatusPromises.push(checkAccountStatus(a));
        });
        const checkFlowNumber = await Promise.all(checkAccountStatusPromises)
        .then(success => {
          const checkFlowNumber = success.reduce((a, b) => {
            return a + b;
          });
          logger.info(`check account flow [${ s.name }] ${ checkFlowNumber }`);
          return checkFlowNumber;
        });
        port.forEach(async p => {
          if(!account.exist(p.port)) {
            delPort(p, s);
          }
        });
        return checkFlowNumber;
      } catch (err) {
        logger.error(err);
        return 0;
      }
    };
    promises.push(checkServerAccount(s));
  });
  Promise.all(promises).then(success => {
    const sum = success.reduce((a, b) => a + b);
    if(sum <= 40) {
      let deleteCount = 40 - sum;
      Object.keys(checkAccountTime).filter((f, i, arr) => {
        return Math.random() <= (deleteCount / arr.length / 2) ? f : null;
      }).forEach(f => {
        delete checkAccountTime[f];
      });
    }
  });
};

exports.checkServer = checkServer;
exports.sendMessage = sendMessage;
exports.addPort = addPort;
exports.delPort = delPort;
exports.changePassword = changePassword;
exports.deleteCheckAccountTimePort = deleteCheckAccountTimePort;
exports.deleteCheckAccountTimeServer = deleteCheckAccountTimeServer;

setTimeout(() => {
  checkServer();
}, 8 * 1000);
cron.minute(() => {
  checkServer();
}, 2);