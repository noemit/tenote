'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('tenote', {
  toggle: () => ipcRenderer.invoke('window:toggle'),
  hide: () => ipcRenderer.invoke('window:hide'),
  resizeStart: (edge) => ipcRenderer.invoke('window:resizeStart', edge),
  resizeEnd: () => ipcRenderer.invoke('window:resizeEnd'),
  ensureSize: (opts) => ipcRenderer.invoke('window:ensureSize', opts),
  saveNote: (payload) => ipcRenderer.invoke('note:save', payload),
  listNotes: () => ipcRenderer.invoke('note:list'),
  readNote: (id) => ipcRenderer.invoke('note:read', id),
  recentNotes: (limit) => ipcRenderer.invoke('note:recent', limit),
  attachImage: (payload) => ipcRenderer.invoke('note:attach', payload),
  pathForFile: (f) => webUtils.getPathForFile(f),
  openNotesFolder: () => ipcRenderer.invoke('notes:openFolder'),
  openLogsFolder: () => ipcRenderer.invoke('logs:openFolder'),
  getState: () => ipcRenderer.invoke('state:get'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setHideOnBlur: (v) => ipcRenderer.invoke('settings:setHideOnBlur', v),
  setLaunchAtLogin: (v) => ipcRenderer.invoke('settings:setLaunchAtLogin', v),
  setTheme: (t) => ipcRenderer.invoke('settings:setTheme', t),
  setHideBrand: (v) => ipcRenderer.invoke('settings:setHideBrand', v),
  setHideRecents: (v) => ipcRenderer.invoke('settings:setHideRecents', v),
  quit: () => ipcRenderer.invoke('app:quit'),
  log: (level, message) => ipcRenderer.send('log', { level, message }),
  invokePlugin: (plugin, method, args) => ipcRenderer.invoke('plugin:invoke', { plugin, method, args }),
  onPluginEvent: (cb) => ipcRenderer.on('plugin:event', (e, evt) => cb(evt)),
  onShown: (cb) => ipcRenderer.on('window:shown', () => cb()),
  onGoto: (cb) => ipcRenderer.on('ui:goto', (e, view) => cb(view)),
});
