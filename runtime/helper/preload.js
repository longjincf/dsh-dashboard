'use strict';
// 仅向渲染进程暴露最小信息；值来自宿主注入的环境变量。
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('dashInfo', {
  port: process.env.DSH_DASH_PORT || 0,
  adminBase: process.env.DSH_DASH_ADMIN_BASE || ''
});
