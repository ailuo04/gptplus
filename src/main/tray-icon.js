'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 原 app 图标的透明背景版本，托盘和后续打包入口共用这一份资源。
const APP_ICON_PATH = path.join(__dirname, 'assets', 'app-icon.png');
const TRAY_ICON_DATA_URL = `data:image/png;base64,${fs.readFileSync(APP_ICON_PATH).toString('base64')}`;

module.exports = { APP_ICON_PATH, TRAY_ICON_DATA_URL };
