'use strict';

/**
 * 管理主窗口关闭行为：普通关闭隐藏到托盘，真正退出或冒烟测试时允许窗口关闭。
 * @param {{isSmoke?: boolean, isQuitting?: () => boolean, hideWindow?: () => void}} options
 * @returns {{handleClose: (event: {preventDefault: () => void}) => boolean}}
 */
function createWindowLifecycle(options = {}) {
  const isSmoke = options.isSmoke === true;
  const isQuitting = typeof options.isQuitting === 'function' ? options.isQuitting : () => false;
  const hideWindow = typeof options.hideWindow === 'function' ? options.hideWindow : () => {};

  return {
    handleClose(event) {
      if (isSmoke || isQuitting()) return false;
      event.preventDefault();
      hideWindow();
      return true;
    },
  };
}

module.exports = { createWindowLifecycle };
