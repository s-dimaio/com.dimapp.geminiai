'use strict';

/**
 * Scheduler
 *
 * Manages timed command execution for HomeyMCPAdapter.
 * Supports two scheduling strategies:
 *  - **Short delay (< 24 h):** `homey.setTimeout` for precise execution.
 *  - **Long delay (≥ 24 h):** periodic checker (every 10 minutes) that reads
 *    persisted commands from Homey settings.
 *
 * Commands are persisted in `homey.settings` under the key `scheduled_commands`
 * so that they survive app restarts.
 */
class Scheduler {

    /**
     * Creates a new Scheduler instance.
     *
     * @public
     * @param {import('homey')} homey - The Homey app instance.
     * @example
     * const scheduler = new Scheduler(homey);
     */
    constructor(homey) {
        this.homey = homey;

        /** @type {?NodeJS.Timeout} Active periodic checker interval (for schedules > 24h) */
        this._schedulerInterval = null;

        /** @type {Map<string, NodeJS.Timeout>} Map of active setTimeout IDs, keyed by scheduleId */
        this._scheduledTimeouts = new Map();
    }

    // ── Public Methods ──────────────────────────────────────────────────────────

    /**
     * Schedules a natural language command for future execution.
     *
     * The `executeAt` timestamp must be expressed in Homey's local timezone
     * (without a UTC suffix). The method converts it to UTC internally.
     * Commands scheduled within 24 hours use `homey.setTimeout`; commands
     * beyond 24 hours are handled by the periodic checker.
     *
     * @public
     * @param {string} command - Natural language MCP command to execute (e.g. `'turn off all lights'`).
     * @param {string} executeAt - ISO 8601 local datetime string (e.g. `'2026-02-08T22:00:00'`).
     * @param {string} description - Human-readable description shown to the user.
     * @returns {Promise<Object>} Result object with `success`, `scheduleId`, timing details, and a
     *   localised confirmation message.
     * @example
     * const result = await scheduler.scheduleCommand(
     *   'turn off lights in living room',
     *   '2026-02-22T23:00:00',
     *   'Turn off lights at 11pm'
     * );
     * // result.scheduleId === 'schedule_1771767033047_80bzk880w'
     */
    async scheduleCommand(command, executeAt, description) {
        try {
            // Validate format
            if (!executeAt || typeof executeAt !== 'string') {
                return {
                    success: false,
                    error: `Invalid datetime format. Received: ${executeAt}`
                };
            }

            // Get Homey's timezone
            let userTimezone = 'UTC';
            try {
                userTimezone = this.homey?.clock?.getTimezone?.() || 'UTC';
            } catch (e) {
                this.homey.log('[scheduleCommand] Could not get timezone, using UTC');
            }

            // Parse executeAt as LOCAL time
            const localDate = new Date(executeAt);

            // Validate parsed date
            if (isNaN(localDate.getTime())) {
                return {
                    success: false,
                    error: 'Invalid datetime format. Use ISO 8601 format (e.g., 2026-02-08T22:00:00)'
                };
            }

            // Convert LOCAL time to UTC by computing the timezone offset
            const utcDate = new Date(localDate.toLocaleString('en-US', { timeZone: 'UTC' }));
            const tzDate = new Date(localDate.toLocaleString('en-US', { timeZone: userTimezone }));
            const offsetMs = tzDate.getTime() - utcDate.getTime();

            const executeUTC = new Date(localDate.getTime() - offsetMs);
            const now = new Date();

            this.homey.log(`[scheduleCommand] Input (local): ${executeAt}`);
            this.homey.log(`[scheduleCommand] Timezone: ${userTimezone}, Offset: ${offsetMs}ms`);
            this.homey.log(`[scheduleCommand] Converted to UTC: ${executeUTC.toISOString()}`);
            this.homey.log(`[scheduleCommand] Current UTC: ${now.toISOString()}`);

            const delayMs = executeUTC.getTime() - now.getTime();

            // Allow 60-second tolerance for race conditions (multi-turn loops take time)
            const TOLERANCE_MS = 60000; // 60 seconds

            if (delayMs < -TOLERANCE_MS) {
                return {
                    success: false,
                    error: 'Scheduled time is too far in the past',
                    requestedTime: executeAt,
                    currentTime: now.toISOString(),
                    delaySeconds: Math.round(delayMs / 1000)
                };
            }

            // If slightly in the past (within tolerance), execute immediately
            const actualDelayMs = Math.max(delayMs, 0);
            const delayMinutes = Math.round(delayMs / 60000);
            const delayHours = Math.round(delayMs / 3600000);
            const delayDays = Math.round(delayMs / 86400000);

            // Limit to 365 days (1 year)
            const MAX_DAYS = 365;
            if (delayDays > MAX_DAYS) {
                return {
                    success: false,
                    error: `Cannot schedule commands more than ${MAX_DAYS} days in the future`,
                    requestedDelay: `${delayDays} giorni`,
                    maxDelay: `${MAX_DAYS} giorni`
                };
            }

            // Create unique identifier
            const scheduleId = `schedule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            // Persist in Homey settings
            const scheduledCommands = this.homey.settings.get('scheduled_commands') || {};
            scheduledCommands[scheduleId] = {
                command,
                executeAt: executeUTC.toISOString(),
                description,
                createdAt: now.toISOString(),
                status: 'pending'
            };
            this.homey.settings.set('scheduled_commands', scheduledCommands);

            this.homey.log(`[scheduleCommand] Scheduled ${scheduleId} for ${executeUTC.toISOString()} (in ${delayMinutes} minutes)`);

            // Hybrid scheduling strategy:
            //  - < 24 h: setTimeout for precise execution
            //  - ≥ 24 h: periodic checker (every 10 minutes)
            const HOURS_24_MS = 24 * 60 * 60 * 1000;

            if (actualDelayMs < HOURS_24_MS) {
                this.homey.log(`[scheduleCommand] Using setTimeout for ${scheduleId} (${Math.round(actualDelayMs / 1000)}s)`);
                this._scheduleWithTimeout(scheduleId, command, actualDelayMs);
            } else {
                this.homey.log(`[scheduleCommand] Using periodic checker for ${scheduleId} (${delayDays} days)`);
                this._ensureSchedulerCheckerRunning();
            }

            // Build human-readable time string
            let timeInfo;
            if (delayMinutes === 0) {
                const seconds = Math.round(actualDelayMs / 1000);
                timeInfo = `${seconds} secondo${seconds !== 1 ? 'i' : ''}`;
            } else if (delayMinutes < 60) {
                timeInfo = `${delayMinutes} minut${delayMinutes !== 1 ? 'i' : 'o'}`;
            } else if (delayHours < 48) {
                timeInfo = `${delayHours} or${delayHours !== 1 ? 'e' : 'a'}`;
            } else {
                timeInfo = `${delayDays} giorn${delayDays !== 1 ? 'i' : 'o'}`;
            }

            return {
                success: true,
                scheduleId,
                command,
                executeAt: executeUTC.toISOString(),
                description,
                delayMinutes,
                delayDays: Math.round(delayDays * 10) / 10,
                message: `Comando programmato con successo. Verrà eseguito tra ${timeInfo}`
            };

        } catch (error) {
            this.homey.error('[scheduleCommand] Error:', error);
            return {
                success: false,
                error: error.message || 'Failed to schedule command'
            };
        }
    }

    /**
     * Restores scheduled commands from persistent settings after an app restart.
     *
     * - Future commands within 24 h are re-registered with `setTimeout`.
     * - Future commands beyond 24 h are handled by the periodic checker.
     * - Past-due commands (expired < 24 h + 10 min ago) are executed immediately.
     * - Commands expired longer than that threshold are deleted from settings.
     *
     * Must be called from `app.js` `onInit()` after the adapter is ready.
     *
     * @public
     * @returns {Promise<void>}
     * @example
     * // In app.js onInit():
     * await this.mcpAdapter.scheduler.restoreScheduledCommands();
     */
    async restoreScheduledCommands() {
        const scheduledCommands = this.homey.settings.get('scheduled_commands') || {};
        const now = new Date();

        let restoredShort = 0;
        let restoredLong = 0;
        let pastDueCount = 0;
        let expiredCount = 0;

        const HOURS_24_MS = 24 * 60 * 60 * 1000;
        const TOLERANCE_MS = 10 * 60 * 1000; // 10 minutes
        const PAST_DUE_THRESHOLD = HOURS_24_MS + TOLERANCE_MS;

        for (const [scheduleId, schedule] of Object.entries(scheduledCommands)) {
            if (schedule.status === 'pending') {
                const executeAt = new Date(schedule.executeAt);
                const delayMs = executeAt.getTime() - now.getTime();

                if (delayMs > 0) {
                    if (delayMs < HOURS_24_MS) {
                        this.homey.log(`[restoreScheduledCommands] Restoring with setTimeout: ${scheduleId} (in ${Math.round(delayMs / 60000)} minutes)`);
                        this._scheduleWithTimeout(scheduleId, schedule.command, delayMs);
                        restoredShort++;
                    } else {
                        this.homey.log(`[restoreScheduledCommands] Will use checker: ${scheduleId} (in ${Math.round(delayMs / 3600000)} hours)`);
                        restoredLong++;
                    }
                } else {
                    const absPastDueMs = Math.abs(delayMs);

                    if (absPastDueMs <= PAST_DUE_THRESHOLD) {
                        const lateMinutes = Math.round(absPastDueMs / 60000);
                        this.homey.log(`[restoreScheduledCommands] Past due: ${scheduleId} (${lateMinutes} min late, will execute immediately)`);
                        pastDueCount++;
                    } else {
                        const lateDays = Math.round(absPastDueMs / (24 * 60 * 60 * 1000));
                        this.homey.log(`[restoreScheduledCommands] Deleting expired: ${scheduleId} (${lateDays} days late, too old)`);
                        delete scheduledCommands[scheduleId];
                        expiredCount++;
                    }
                }
            }
        }

        // Save cleaned settings (expired commands deleted)
        if (expiredCount > 0) {
            this.homey.settings.set('scheduled_commands', scheduledCommands);
        }

        // Start periodic checker if there are long-delay schedules
        if (restoredLong > 0) {
            this._ensureSchedulerCheckerRunning();
        }

        if (restoredShort > 0 || restoredLong > 0 || pastDueCount > 0 || expiredCount > 0) {
            this.homey.log(`[restoreScheduledCommands] Found ${restoredShort} short (setTimeout), ${restoredLong} long (checker), ${pastDueCount} past-due, ${expiredCount} expired (deleted)`);

            if (pastDueCount > 0) {
                this.homey.log(`[restoreScheduledCommands] Executing ${pastDueCount} past-due commands now`);
                await this._checkAndExecutePendingCommands();
            }
        }
    }

    /**
     * Cancels a previously scheduled command.
     *
     * Clears the associated `setTimeout` (if any) and removes the entry from
     * Homey settings.
     *
     * @public
     * @param {string} scheduleId - The schedule ID returned by {@link scheduleCommand}.
     * @returns {Promise<Object>} Result object with `success` flag and the cancelled command details.
     * @example
     * const result = await scheduler.cancelScheduledCommand('schedule_1771767033047_80bzk880w');
     * // result.success === true
     */
    async cancelScheduledCommand(scheduleId) {
        try {
            this.homey.log(`[cancelScheduledCommand] Called with scheduleId: ${scheduleId}`);

            const scheduledCommands = this.homey.settings.get('scheduled_commands') || {};

            this.homey.log(`[cancelScheduledCommand] Current scheduled commands:`, Object.keys(scheduledCommands));

            if (!scheduledCommands[scheduleId]) {
                return {
                    success: false,
                    error: `Schedule ${scheduleId} not found`
                };
            }

            const schedule = scheduledCommands[scheduleId];

            // Clear active setTimeout if present
            if (this._scheduledTimeouts.has(scheduleId)) {
                const timeoutId = this._scheduledTimeouts.get(scheduleId);
                this.homey.clearTimeout(timeoutId);
                this._scheduledTimeouts.delete(scheduleId);
                this.homey.log(`[cancelScheduledCommand] Cleared setTimeout for: ${scheduleId}`);
            }

            // Remove from settings
            delete scheduledCommands[scheduleId];
            this.homey.settings.set('scheduled_commands', scheduledCommands);

            this.homey.log(`[cancelScheduledCommand] Cancelled and removed: ${scheduleId}`);

            return {
                success: true,
                scheduleId,
                command: schedule.command,
                message: `Successfully cancelled scheduled command: ${schedule.description || schedule.command}`
            };
        } catch (error) {
            this.homey.error(`[cancelScheduledCommand] Error:`, error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Releases all resources held by this scheduler.
     *
     * Clears the periodic checker interval and empties the timeout tracking map.
     * Must be called from `app.js` `onUninit()`.
     *
     * @public
     * @returns {void}
     * @example
     * // In app.js onUninit():
     * this.mcpAdapter.scheduler.cleanup();
     */
    cleanup() {
        if (this._schedulerInterval) {
            this.homey.clearInterval(this._schedulerInterval);
            this.homey.log('[schedulerChecker] Stopped');
        }

        if (this._scheduledTimeouts && this._scheduledTimeouts.size > 0) {
            this.homey.log(`[cleanup] Clearing ${this._scheduledTimeouts.size} active setTimeout timers`);
            // homey.setTimeout timers are auto-cleared on app destroy, but we track them for visibility
            this._scheduledTimeouts.clear();
        }
    }

    // ── Private Methods ─────────────────────────────────────────────────────────

    /**
     * Starts the periodic checker that runs every 10 minutes.
     * Only used for commands scheduled more than 24 hours in the future.
     *
     * @private
     * @returns {void}
     */
    _startSchedulerChecker() {
        if (this._schedulerInterval) {
            return; // Already running
        }

        const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

        this._schedulerInterval = this.homey.setInterval(async () => {
            await this._checkAndExecutePendingCommands();
        }, CHECK_INTERVAL_MS);

        this.homey.log('[schedulerChecker] Started (check every 10 minutes for long schedules)');
    }

    /**
     * Starts the periodic checker if it is not already running.
     *
     * @private
     * @returns {void}
     */
    _ensureSchedulerCheckerRunning() {
        if (!this._schedulerInterval) {
            this._startSchedulerChecker();
        }
    }

    /**
     * Registers a command for execution using `homey.setTimeout`.
     * Used for commands scheduled within 24 hours.
     *
     * @private
     * @param {string} scheduleId - Unique schedule identifier.
     * @param {string} command - Natural language command to execute.
     * @param {number} delayMs - Delay in milliseconds before execution.
     * @returns {void}
     */
    _scheduleWithTimeout(scheduleId, command, delayMs) {
        const timeoutId = this.homey.setTimeout(async () => {
            this.homey.log(`[setTimeout] Executing scheduled command: ${scheduleId}`);
            await this._executeScheduledCommand(scheduleId, command);
            this._scheduledTimeouts.delete(scheduleId);
        }, delayMs);

        this._scheduledTimeouts.set(scheduleId, timeoutId);
    }

    /**
     * Checks all persisted pending commands and executes any whose time has passed.
     * Called by the periodic checker and on restart for past-due commands.
     *
     * @private
     * @returns {Promise<void>}
     */
    async _checkAndExecutePendingCommands() {
        const scheduledCommands = this.homey.settings.get('scheduled_commands') || {};
        const now = new Date();

        for (const [scheduleId, schedule] of Object.entries(scheduledCommands)) {
            if (schedule.status === 'pending') {
                const executeAt = new Date(schedule.executeAt);

                if (now >= executeAt) {
                    this.homey.log(`[schedulerChecker] Executing due command: ${scheduleId}`);
                    await this._executeScheduledCommand(scheduleId, schedule.command);
                }
            }
        }
    }

    /**
     * Executes a scheduled command via `GeminiClient.generateTextWithMCP` and
     * triggers the `scheduled_command_executed` flow card.
     * Removes the command from settings regardless of execution outcome.
     *
     * @private
     * @param {string} scheduleId - The schedule ID to execute and remove.
     * @param {string} command - The natural language command to execute.
     * @returns {Promise<void>}
     */
    async _executeScheduledCommand(scheduleId, command) {
        this.homey.log(`[_executeScheduledCommand] Executing: ${scheduleId}`);

        try {
            const app = this.homey.app;

            if (!app.geminiClient) {
                throw new Error('GeminiClient not initialized');
            }

            // Recupera la data di creazione per fornire un contesto più preciso a Gemini
            let scheduledCommands = this.homey.settings.get('scheduled_commands') || {};
            const scheduleData = scheduledCommands[scheduleId];
            const options = {
                isScheduled: true,
                createdAt: scheduleData ? scheduleData.createdAt : null
            };

            const result = await app.geminiClient.generateTextWithMCP(command, options);

            // Remove from settings after successful execution
            scheduledCommands = this.homey.settings.get('scheduled_commands') || {};
            if (scheduledCommands[scheduleId]) {
                this.homey.log(`[_executeScheduledCommand] Removing executed command from settings: ${scheduleId}`);
                delete scheduledCommands[scheduleId];
                this.homey.settings.set('scheduled_commands', scheduledCommands);
            }

            // Trigger flow card notification.
            // Use the reference registered in app.js onInit() so that Homey SDK 3
            // Flow Engine has already mapped this card to matching flows.
            const trigger = this.homey.app.scheduledCommandExecutedTrigger
                || this.homey.flow.getTriggerCard('scheduled_command_executed');
            if (trigger) {
                this.homey.log(`[_executeScheduledCommand] Triggering flow card 'scheduled_command_executed' for ${scheduleId}...`);
                await trigger.trigger({
                    command: command,
                    success: result.success,
                    response: result.response,
                    timer_id: scheduleId
                });
                this.homey.log(`[_executeScheduledCommand] Flow card 'scheduled_command_executed' successfully triggered for ${scheduleId}`);
            } else {
                this.homey.log(`[_executeScheduledCommand] WARNING: Flow card 'scheduled_command_executed' not found, trigger skipped for ${scheduleId}`);
            }


            this.homey.log(`[_executeScheduledCommand] Completed: ${scheduleId} - Success: ${result.success}`);

        } catch (error) {
            this.homey.error(`[_executeScheduledCommand] Failed for ${scheduleId}:`, error);

            // Remove from settings even on error to avoid infinite retries
            const scheduledCommands = this.homey.settings.get('scheduled_commands') || {};
            if (scheduledCommands[scheduleId]) {
                this.homey.log(`[_executeScheduledCommand] Removing failed command from settings: ${scheduleId}`);
                delete scheduledCommands[scheduleId];
                this.homey.settings.set('scheduled_commands', scheduledCommands);
            }
        }
    }
}

module.exports = { Scheduler };
