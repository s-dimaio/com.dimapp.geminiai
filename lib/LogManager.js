'use strict';

const fs = require('fs');
const path = require('path');

const SETTING_DEBUG_LOGGING = 'debug_logging_enabled';
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_LOG_FILES = 3;
const MAX_QUEUE_SIZE = 2000;
const BASE_LOG_FILENAME = 'app_debug.log';

/**
 * Diagnostic Log Manager for Athom Homey Pro (SDK v3).
 *
 * Implements a rotatable, persistent file logging system stored in `/userdata/`
 * with multi-file rotation (3 files x 2 MB), asynchronous write queuing,
 * automatic PII/credential sanitization, and console output interception.
 *
 * @class LogManager
 */
class LogManager {
  /**
   * Initializes the LogManager with the Homey App instance context.
   *
   * @public
   * @constructor
   * @param {import('homey').App} app - The Homey App instance.
   * @example
   * const logManager = new LogManager(this);
   * await logManager.init();
   */
  constructor(app) {
    this._app = app;
    this._isDebugEnabled = false;
    this._logDirectory = this._resolveLogDirectory();
    this._isWriting = false;
    this._writeQueue = [];
    this._isInternalLogging = false;
    this._consoleHookInstalled = false;
    this._originalConsole = null;
  }

  /**
   * Initializes the logger directory, reads persisted debug state,
   * and sets up the console interceptor if debug logging is enabled.
   *
   * @public
   * @async
   * @returns {Promise<void>}
   * @example
   * await logManager.init();
   */
  async init() {
    try {
      this._ensureLogDirectory();
      const savedSetting = this._app.homey.settings.get(SETTING_DEBUG_LOGGING);
      this._isDebugEnabled = Boolean(savedSetting);

      this._setupConsoleInterceptor();

      if (this._app && typeof this._app.log === 'function') {
        this._app.log(`[LogManager:init] Target log directory: ${this._logDirectory}`);
        this._app.log(`[LogManager:init] Diagnostic logging is currently ${this._isDebugEnabled ? 'ENABLED' : 'DISABLED'}`);
      }
    } catch (error) {
      if (this._app && typeof this._app.error === 'function') {
        this._app.error('[LogManager:init] Failed to initialize LogManager:', error.message || error);
      }
    }
  }

  /**
   * Checks whether diagnostic logging is currently enabled.
   *
   * @public
   * @returns {boolean} True if diagnostic logging is active, false otherwise.
   * @example
   * if (logManager.isDebugEnabled()) {
   *   logManager.writeLog('DEBUG', 'Module:test', 'Debug payload');
   * }
   */
  isDebugEnabled() {
    return this._isDebugEnabled;
  }

  /**
   * Updates the diagnostic logging state, persists it to Homey settings,
   * and records an activation trace when enabled.
   *
   * @public
   * @async
   * @param {boolean} enabled - True to enable diagnostic logging, false to disable.
   * @returns {Promise<boolean>} The updated diagnostic logging state.
   * @example
   * await logManager.setDebugEnabled(true);
   */
  async setDebugEnabled(enabled) {
    this._isDebugEnabled = Boolean(enabled);
    this._app.homey.settings.set(SETTING_DEBUG_LOGGING, this._isDebugEnabled);

    if (this._app && typeof this._app.log === 'function') {
      this._app.log(`[LogManager:setDebugEnabled] Diagnostic logging state changed to: ${this._isDebugEnabled}`);
    }

    if (this._isDebugEnabled) {
      this.writeLog('INFO', 'LogManager:setDebugEnabled', 'Diagnostic logging has been enabled by user.');
    }

    return this._isDebugEnabled;
  }

  /**
   * Enqueues a formatted, sanitized log entry for background disk persistence.
   * Discards DEBUG level logs if diagnostic logging is disabled.
   *
   * @public
   * @param {string} level - Log level ('INFO', 'DEBUG', 'WARN', 'ERROR').
   * @param {string} tag - Context identifier (e.g. 'GeminiClient:generateTextWithMCP').
   * @param {any} message - Log payload (string, object, or Error).
   * @returns {void}
   * @example
   * logManager.writeLog('INFO', 'GeminiClient:reasoning', 'Extracted thinking content');
   */
  writeLog(level, tag, message) {
    if (!this._isDebugEnabled && level === 'DEBUG') return;
    if (message === null || message === undefined) return;

    let textContent;
    if (message instanceof Error) {
      textContent = message.stack || message.message || String(message);
    } else if (typeof message === 'object') {
      try {
        textContent = JSON.stringify(message);
      } catch (err) {
        textContent = String(message);
      }
    } else {
      textContent = String(message);
    }

    if (!textContent || textContent === 'null' || textContent === 'undefined') return;

    const timestamp = new Date().toISOString();
    textContent = this._sanitize(textContent);
    const logLine = `[${timestamp}] [${level.toUpperCase()}] [${tag}] ${textContent}\n`;

    if (this._isDebugEnabled) {
      this._enqueueWrite(logLine);
    }
  }

  /**
   * Clears the in-memory write buffer.
   *
   * @public
   * @returns {void}
   * @example
   * logManager.clearWriteQueue();
   */
  clearWriteQueue() {
    this._writeQueue = [];
  }

  /**
   * Returns the absolute path of a diagnostic log file by its rotation index.
   * Index 0 is the active file, while 1 and 2 are previous rotated backups.
   *
   * @public
   * @param {number} index - The rotation index (0 for active, 1+ for backups).
   * @returns {string} The absolute path to the log file.
   * @example
   * const path = logManager.getLogFilePath(0);
   */
  getLogFilePath(index) {
    return this._getLogFilePath(index);
  }

  /**
   * Clears and deletes all stored diagnostic log files and resets the write buffer.
   *
   * @public
   * @async
   * @returns {Promise<boolean>} True if all log files were cleared successfully.
   * @throws {Error} If file deletion fails.
   * @example
   * await logManager.clearLogs();
   */
  async clearLogs() {
    try {
      this._writeQueue = [];
      for (let i = 0; i < MAX_LOG_FILES; i++) {
        const filePath = this._getLogFilePath(i);
        if (fs.existsSync(filePath)) {
          await fs.promises.unlink(filePath).catch(() => {});
        }
      }
      if (this._app && typeof this._app.log === 'function') {
        this._app.log('[LogManager:clearLogs] All diagnostic log files cleared successfully.');
      }
      return true;
    } catch (error) {
      if (this._app && typeof this._app.error === 'function') {
        this._app.error('[LogManager:clearLogs] Failed to clear log files:', error.message || error);
      }
      throw error;
    }
  }

  /**
   * Restores original console methods and releases references on app teardown.
   *
   * @public
   * @returns {void}
   * @example
   * logManager.destroy();
   */
  destroy() {
    this._restoreConsoleInterceptor();
    this._writeQueue = [];
  }

  // ── Private Methods ──────────────────────────────────────────────────────────

  /**
   * Resolves the persistent writable directory for diagnostic logs.
   * Prefers `/userdata` on Homey runtime, with fallbacks for local development.
   *
   * @private
   * @returns {string} The resolved directory path.
   */
  _resolveLogDirectory() {
    if (fs.existsSync('/userdata')) return '/userdata';
    if (this._app && this._app.homey && this._app.homey.dir) {
      return path.join(this._app.homey.dir, 'userdata');
    }
    return path.join(process.cwd(), 'userdata');
  }

  /**
   * Ensures that the persistent log directory exists on disk.
   *
   * @private
   * @returns {void}
   */
  _ensureLogDirectory() {
    if (!fs.existsSync(this._logDirectory)) {
      try {
        fs.mkdirSync(this._logDirectory, { recursive: true });
      } catch (err) {
        // Directory may already exist or cannot be created
      }
    }
  }

  /**
   * Computes the absolute file path for a specific log rotation index.
   *
   * @private
   * @param {number} index - The rotation index.
   * @returns {string} The absolute file path.
   */
  _getLogFilePath(index) {
    if (index === 0) return path.join(this._logDirectory, BASE_LOG_FILENAME);
    return path.join(this._logDirectory, `app_debug.${index}.log`);
  }

  /**
   * Adds a sanitized log line to the in-memory write queue, enforcing maximum buffer bounds.
   *
   * @private
   * @param {string} line - The formatted log line to enqueue.
   * @returns {void}
   */
  _enqueueWrite(line) {
    this._writeQueue.push(line);
    if (this._writeQueue.length > MAX_QUEUE_SIZE) {
      this._writeQueue.splice(0, this._writeQueue.length - MAX_QUEUE_SIZE);
    }
    this._scheduleProcessing();
  }

  /**
   * Schedules background queue processing via setImmediate to decouple disk I/O from execution.
   *
   * @private
   * @returns {void}
   */
  _scheduleProcessing() {
    if (this._isWriting) return;
    this._isWriting = true;

    setImmediate(async () => {
      try {
        await this._processWriteQueue();
      } catch (err) {
        if (this._app && typeof this._app.error === 'function') {
          this._app.error('[LogManager:_scheduleProcessing] Error writing log batch:', err.message || err);
        }
      } finally {
        this._isWriting = false;
        if (this._writeQueue.length > 0) {
          this._scheduleProcessing();
        }
      }
    });
  }

  /**
   * Drains the write queue in batches of up to 100 lines, verifying file size and rotating as needed.
   *
   * @private
   * @async
   * @returns {Promise<void>}
   */
  async _processWriteQueue() {
    if (this._writeQueue.length === 0) return;
    this._ensureLogDirectory();
    const activeFilePath = this._getLogFilePath(0);

    while (this._writeQueue.length > 0) {
      await this._checkAndRotateFile(activeFilePath);
      const batch = this._writeQueue.splice(0, 100).join('');
      await fs.promises.appendFile(activeFilePath, batch, 'utf8');
      await this._checkAndRotateFile(activeFilePath);
    }
  }

  /**
   * Checks if the active log file has exceeded the maximum size limit and shifts rotated backups.
   *
   * @private
   * @async
   * @param {string} activeFilePath - Absolute path to the active log file.
   * @returns {Promise<void>}
   */
  async _checkAndRotateFile(activeFilePath) {
    try {
      if (!fs.existsSync(activeFilePath)) return;
      const stats = await fs.promises.stat(activeFilePath).catch(() => null);
      if (!stats || stats.size < MAX_FILE_SIZE_BYTES) return;

      const oldestIndex = MAX_LOG_FILES - 1;
      const oldestPath = this._getLogFilePath(oldestIndex);
      if (fs.existsSync(oldestPath)) {
        await fs.promises.unlink(oldestPath).catch(() => {});
      }

      for (let i = oldestIndex - 1; i >= 1; i--) {
        const currentPath = this._getLogFilePath(i);
        const nextPath = this._getLogFilePath(i + 1);
        if (fs.existsSync(currentPath)) {
          if (fs.existsSync(nextPath)) {
            await fs.promises.unlink(nextPath).catch(() => {});
          }
          await fs.promises.rename(currentPath, nextPath).catch(() => {});
        }
      }

      const firstBackupPath = this._getLogFilePath(1);
      if (fs.existsSync(firstBackupPath)) {
        await fs.promises.unlink(firstBackupPath).catch(() => {});
      }
      await fs.promises.rename(activeFilePath, firstBackupPath).catch(() => {});
    } catch (error) {
      // Rotation failures are non-fatal
    }
  }

  /**
   * Masks sensitive credentials, Bearer tokens, Gemini API keys, passwords, and email addresses.
   *
   * @private
   * @param {string} text - The input text string to sanitize.
   * @returns {string} The sanitized text string.
   */
  _sanitize(text) {
    if (!text || typeof text !== 'string') return text;
    return text
      .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer ***MASKED***')
      .replace(/\bAIzaSy[A-Za-z0-9\-_]{33}\b/g, 'AIzaSy***MASKED***')
      .replace(/\b(password|client_secret|client_id|access_token|refresh_token|id_token|code|api_key|apiKey)(["']?\s*[:=]\s*["']?)([^"'\s&,;]{1,500})(["']?)/gi, '$1$2***MASKED***$4')
      .replace(/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,10}\b/gi, '***@***.***');
  }

  /**
   * Installs interception wrappers on console methods (log, info, warn, error)
   * to guarantee that all system and module logs are captured by the diagnostic system.
   *
   * @private
   * @returns {void}
   */
  _setupConsoleInterceptor() {
    if (this._consoleHookInstalled) return;

    this._originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error
    };

    const handleInterceptedLog = (level, args) => {
      if (!this._isDebugEnabled || this._isInternalLogging) return;

      this._isInternalLogging = true;
      try {
        const formatted = args.map(arg => {
          if (arg instanceof Error) {
            return arg.stack || arg.message || String(arg);
          }
          if (typeof arg === 'object' && arg !== null) {
            try {
              return JSON.stringify(arg);
            } catch (e) {
              return String(arg);
            }
          }
          return String(arg);
        }).join(' ');

        if (!formatted || formatted.trim().length === 0) return;

        // Extract structured tag if present (e.g. [ClassName:methodName] or [Module])
        let tag = 'Console';
        let body = formatted;
        const tagMatch = formatted.match(/^\[([a-zA-Z0-9_:\- .]+)\]\s*(.*)$/s);
        if (tagMatch) {
          tag = tagMatch[1];
          body = tagMatch[2];
        }

        const timestamp = new Date().toISOString();
        const sanitizedBody = this._sanitize(body);
        const logLine = `[${timestamp}] [${level}] [${tag}] ${sanitizedBody}\n`;
        this._enqueueWrite(logLine);
      } catch (err) {
        // Fallback: never crash application due to logging hook
      } finally {
        this._isInternalLogging = false;
      }
    };

    console.log = (...args) => {
      this._originalConsole.log.apply(console, args);
      handleInterceptedLog('INFO', args);
    };

    console.info = (...args) => {
      this._originalConsole.info.apply(console, args);
      handleInterceptedLog('INFO', args);
    };

    console.warn = (...args) => {
      this._originalConsole.warn.apply(console, args);
      handleInterceptedLog('WARN', args);
    };

    console.error = (...args) => {
      this._originalConsole.error.apply(console, args);
      handleInterceptedLog('ERROR', args);
    };

    this._consoleHookInstalled = true;
  }

  /**
   * Restores original console methods when the LogManager is destroyed.
   *
   * @private
   * @returns {void}
   */
  _restoreConsoleInterceptor() {
    if (!this._consoleHookInstalled || !this._originalConsole) return;
    console.log = this._originalConsole.log;
    console.info = this._originalConsole.info;
    console.warn = this._originalConsole.warn;
    console.error = this._originalConsole.error;
    this._consoleHookInstalled = false;
  }
}

module.exports = LogManager;
