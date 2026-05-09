const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('__EHOSER_DESKTOP__', true);
contextBridge.exposeInMainWorld('__EHOSER_API_ORIGIN__', 'https://ehoser.de');
