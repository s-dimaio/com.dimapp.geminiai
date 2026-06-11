'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Time window in hours during which subsequent flow modifications will not overwrite
 * the initial backup. This prevents Gemini from overwriting a working flow backup
 * with broken intermediate configurations.
 *
 * @type {number}
 */
const BACKUP_PROTECTION_HOURS = 2;

/**
 * FlowManager
 *
 * Handles all Flow-related operations, including Standard Flows, Advanced Flows,
 * HomeyScript execution proxy, and backup management.
 */
class FlowManager {
  /**
   * Creates a new FlowManager instance.
   *
   * @public
   * @param {import('homey')} homey - The Homey app instance.
   * @param {Object} adapter - The parent HomeyMCPAdapter instance.
   */
  constructor(homey, adapter) {
    this.homey = homey;
    this.adapter = adapter;
    
    /** @type {?string} Cache for the HomeyScript proxy script ID */
    this._homeyScriptProxyId = null;
  }

  /**
   * Triggers a Homey Flow (standard or Advanced) by name.
   *
   * Uses the HomeyScript proxy to obtain the `homey.flow.start` scope
   * that third-party apps cannot request directly.
   *
   * @public
   * @param {string} flowName - Exact flow name (case-insensitive).
   * @param {Object} [args={}] - Optional arguments/tokens for Advanced Flows.
   * @returns {Promise<Object>} Result with `success`, `flowName`, `flowId`, `flowType`, `message`.
   * @example
   * const result = await flowManager.triggerFlow('Good Morning', { greeting: 'Hello' });
   */
  async triggerFlow(flowName, args = {}) {
    if (!flowName) {
      return { success: false, error: "Missing required parameter 'flowName'. Please specify the name of the Flow to trigger." };
    }

    await this.adapter.initialize();

    try {
      const standardFlows = await this.adapter.api.flow.getFlows();
      const advancedFlows = await this.adapter.api.flow.getAdvancedFlows();

      let flow = Object.values(standardFlows).find(f => f.name.toLowerCase() === flowName.toLowerCase());
      let flowType = 'standard';

      if (!flow) {
        flow = Object.values(advancedFlows).find(f => f.name.toLowerCase() === flowName.toLowerCase());
        flowType = 'advanced';
      }

      if (!flow) {
        const allFlows = [...Object.values(standardFlows), ...Object.values(advancedFlows)];
        return { success: false, error: `Flow "${flowName}" not found`, availableFlows: allFlows.map(f => f.name) };
      }

      this.homey.log(`[FlowManager] Found flow: ${flow.name}, type: ${flowType}, triggerable: ${flow.triggerable}, id: ${flow.id}`);

      if (flow.triggerable === false) {
        return {
          success: false,
          error: `Flow "${flow.name}" cannot be manually triggered. Only flows with a "This Flow is started" trigger card can be manually triggered.`,
          flowName: flow.name,
          flowId: flow.id,
          flowType
        };
      }

      this.homey.log(`[FlowManager] Triggering ${flowType} flow via HomeyScript proxy, id: ${flow.id}`);
      await this._triggerFlowViaHomeyScript(flow.id, flowType, args);

      return {
        success: true,
        flowName: flow.name,
        flowId: flow.id,
        flowType,
        triggeredWithArgs: args,
        message: `Successfully triggered ${flowType} flow "${flow.name}"`
      };

    } catch (err) {
      this.homey.error('[FlowManager] triggerFlow Error:', err.message);
      return { success: false, error: `Failed to trigger flow "${flowName}": ${err.message}` };
    }
  }

  /**
   * Lists Homey Flows (standard and/or Advanced) with optional filters.
   *
   * @public
   * @param {boolean|null} [enabled=null] - Filter by enabled status; `null` returns all.
   * @param {string|null} [folder=null] - Filter by folder name (case-insensitive).
   * @param {string} [type='all'] - Filter by type: `'standard'`, `'advanced'`, or `'all'`.
   * @returns {Promise<Object>} Result with `success`, `summary`, `flows`, `message`.
   */
  async listFlows(enabled = null, folder = null, type = 'all') {
    try {
      await this.adapter.initialize();

      const standardFlows = await this.adapter.api.flow.getFlows();
      const advancedFlows = await this.adapter.api.flow.getAdvancedFlows();

      let allFlows = [
        ...Object.values(standardFlows).map(f => ({ ...f, type: 'standard' })),
        ...Object.values(advancedFlows).map(f => ({ ...f, type: 'advanced' }))
      ];

      if (enabled !== null) allFlows = allFlows.filter(f => f.enabled === enabled);
      if (folder) allFlows = allFlows.filter(f => f.folder && f.folder.toLowerCase() === folder.toLowerCase());
      if (type && type !== 'all') allFlows = allFlows.filter(f => f.type === type);

      const flowList = allFlows.map(f => ({
        name: f.name,
        id: f.id,
        enabled: f.enabled !== false,
        folder: f.folder || null,
        type: f.type
      }));

      const summary = {
        total: flowList.length,
        standard: flowList.filter(f => f.type === 'standard').length,
        advanced: flowList.filter(f => f.type === 'advanced').length,
        enabled: flowList.filter(f => f.enabled).length,
        disabled: flowList.filter(f => !f.enabled).length
      };

      return {
        success: true,
        summary,
        flows: flowList,
        message: `Found ${flowList.length} flow(s) (${summary.standard} standard, ${summary.advanced} advanced)`
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Returns detailed information about a specific Homey Flow.
   *
   * Searches both standard and Advanced Flows. If not found, suggests
   * similar flow names using partial string matching.
   *
   * @public
   * @param {string} flowName - Flow name to look up (case-insensitive).
   * @returns {Promise<Object>} Result with `success`, `flow` details, and `message`.
   */
  async getFlowInfo(flowName) {
    if (!flowName) {
      return { success: false, error: "Missing required parameter 'flowName'. Please specify the name of the Flow." };
    }

    try {
      await this.adapter.initialize();

      const standardFlows = await this.adapter.api.flow.getFlows();
      const advancedFlows = await this.adapter.api.flow.getAdvancedFlows();

      let flow = Object.values(standardFlows).find(f => f.name.toLowerCase() === flowName.toLowerCase());
      let flowType = 'standard';

      if (!flow) {
        flow = Object.values(advancedFlows).find(f => f.name.toLowerCase() === flowName.toLowerCase());
        flowType = 'advanced';
      }

      if (!flow) {
        const allFlows = [...Object.values(standardFlows), ...Object.values(advancedFlows)];
        const suggestion = this._suggestDeviceClass(flowName, allFlows.map(f => f.name));
        return {
          success: false,
          error: `Flow "${flowName}" not found.${suggestion ? ` Did you mean "${suggestion}"?` : ''} Call discover_flows to get all available flow names, then retry using one of the exact names in availableFlows.`,
          availableFlows: allFlows.map(f => f.name),
          suggestion: suggestion || null
        };
      }

      return {
        success: true,
        flow: {
          name: flow.name,
          id: flow.id,
          enabled: flow.enabled !== false,
          folder: flow.folder || null,
          type: flowType
        },
        message: `Flow "${flow.name}" is a ${flowType} flow, ${flow.enabled ? 'enabled' : 'disabled'}`
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Lists all Flow Cards of a given type (action, trigger, condition) with optional filtering.
   *
   * @public
   * @param {string|Object} [optionsOrCardType='action'] - Type of flow card to retrieve, or destructured options object.
   * @param {string|null} [deviceName=null] - Filter by device name (case-insensitive). Required for 'action'.
   * @param {string|null} [deviceId=null] - Filter by device UUID (fallback for ambiguous names).
   * @param {string|null} [ownerUri=null] - Filter by ownerUri for app/system manager cards.
   * @returns {Promise<Object>} Result with `success`, `count`, `cards`, and optional `deviceName`.
   */
  async discoverFlowCards(optionsOrCardType = 'action', deviceName = null, deviceId = null, ownerUri = null) {
    let cardType = 'action';
    if (optionsOrCardType && typeof optionsOrCardType === 'object') {
      cardType = optionsOrCardType.cardType || 'action';
      deviceName = optionsOrCardType.deviceName || null;
      deviceId = optionsOrCardType.deviceId || null;
      ownerUri = optionsOrCardType.ownerUri || optionsOrCardType.filterByApp || optionsOrCardType.filterByUri || null;
    } else {
      cardType = optionsOrCardType;
    }

    if (!deviceName && !deviceId && !ownerUri) {
      if (cardType === 'action') {
        return { success: false, error: "Missing required parameter: provide 'deviceName' or 'deviceId' for action cards." };
      }
      return {
        success: false,
        error: `Missing filter: provide 'deviceName' or 'ownerUri' when cardType='${cardType}' to avoid fetching too many results.`
      };
    }

    try {
      await this.adapter.initialize();
      let device = null;

      if (deviceId || deviceName) {
        try {
          const resolved = await this._resolveDevice(deviceName, deviceId);
          device = resolved.device;
        } catch (err) {
          if (err.ambiguous) {
            return {
              success: false,
              ambiguous: true,
              error: err.message,
              matches: err.matches
            };
          }
          return { success: false, error: err.message };
        }
      }

      let allCards;
      if (cardType === 'trigger') {
        allCards = await this.adapter.api.flow.getFlowCardTriggers();
      } else if (cardType === 'condition') {
        allCards = await this.adapter.api.flow.getFlowCardConditions();
      } else {
        allCards = await this.adapter.api.flow.getFlowCardActions();
      }

      const effectiveOwnerUri = device ? ('homey:device:' + device.id) : null;
      const filteredCards = Object.values(allCards).filter(card => {
        if (effectiveOwnerUri) return card.ownerUri === effectiveOwnerUri || card.ownerUri === device.uri;
        if (ownerUri) return card.ownerUri === ownerUri;
        return false;
      });

      const formatted = filteredCards.map(card => ({
        id: card.id,
        title: card.titleFormatted || card.title,
        args: card.args || [],
        ...(cardType === 'action' ? { tokens: card.tokens || [] } : {})
      }));

      return {
        success: true,
        cardType,
        ...(device ? { deviceName: device.name } : { ownerUri: ownerUri || effectiveOwnerUri }),
        count: formatted.length,
        cards: formatted
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Executes a specific Action Card on a device via the HomeyScript proxy.
   *
   * @public
   * @param {string} deviceName - Device name hint.
   * @param {string} cardId - Action card ID.
   * @param {Object} [args={}] - Arguments required by the action card.
   * @param {string|null} [deviceId=null] - Optional device UUID.
   * @returns {Promise<Object>} Result.
   */
  async runActionCard(deviceName, cardId, args = {}, deviceId = null) {
    try {
      await this.adapter.initialize();

      const tempCard = { id: cardId, args };
      await this._normalizeCardArgs(tempCard, 'runActionCard');
      args = tempCard.args || {};

      let device;
      try {
        let targetId = deviceId;
        if (!targetId) {
          const deviceIdMatch = cardId && cardId.match(/^homey:device:([^:]+):/);
          if (deviceIdMatch) {
            targetId = deviceIdMatch[1];
          }
        }
        const resolved = await this._resolveDevice(deviceName, targetId);
        device = resolved.device;
      } catch (err) {
        if (err.ambiguous) {
          return {
            success: false,
            ambiguous: true,
            error: err.message,
            matches: err.matches
          };
        }
        return { success: false, error: err.message };
      }

      const card = await this.adapter.api.flow.getFlowCardAction({ id: cardId, uri: 'homey:device:' + device.id });
      if (!card) {
        return { success: false, error: `Action card "${cardId}" not found on device "${device.name}". Call discover_flow_cards with cardType="action" and deviceName="${device.name}" to get valid card IDs, then retry run_action_card.` };
      }

      if (card.args && Array.isArray(card.args)) {
        const requiredArgs = card.args.filter(a => a.required !== false);
        const missingArgs = [];

        for (const argDef of requiredArgs) {
          const val = args && args[argDef.name];
          const isToken = typeof val === 'string' && /^\[\[.+]]$/.test(val.trim());
          if (isToken) continue;

          const isEmpty = val === undefined || val === null || val === '' || val === 'null';
          if (isEmpty) {
            missingArgs.push({ name: argDef.name, type: argDef.type });
          }
        }

        if (missingArgs.length > 0) {
          const schemaHint = requiredArgs.map(a => `${a.name} (${a.type})`).join(', ');
          const missing = missingArgs.map(a => `${a.name} (${a.type})`).join(', ');
          const issueDetails = `Action card "${cardId}" is missing required arguments: [${missing}]. Full schema: { ${schemaHint} }`;
          this.homey.log(`[runActionCard] Pre-execution validation failed: ${issueDetails}`);
          return {
            success: false,
            error: `Cannot run action card: missing required arguments. Fix all issues and retry: ${issueDetails}`
          };
        }
      }

      const hasImageToken = card.tokens && card.tokens.some(t => t.type === 'image');
      const deviceUri = 'homey:device:' + device.id;

      this.homey.log(`[FlowManager] Running action card via HomeyScript proxy: ${cardId}`);
      const actionResult = await this._runActionCardViaHomeyScript(cardId, deviceUri, args);

      const response = {
        success: true,
        message: `Executed action "${card.titleFormatted || card.title}" on ${device.name}`
      };

      if (actionResult && typeof actionResult === 'object') {
        response.tokens = actionResult;
      }

      if (hasImageToken) {
        this.homey.log(`[FlowManager] Action card has image token, fetching device image...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        const imageData = await this._fetchDeviceImage(device.id);
        if (imageData) {
          response._imageData = imageData.imageBase64;
          response._imageMimeType = imageData.mimeType;
          response._hasImage = true;
          this.homey.log(`[FlowManager] Image fetched successfully: ${imageData.imageId}`);
        } else {
          this.homey.log(`[FlowManager] No image found for device ${device.id}`);
        }
      }

      return response;

    } catch (error) {
      this.homey.error(`[runActionCard] Error:`, error);

      const missingArgMatch = error.message && error.message.match(/Missing argument '([^']+)' for card '([^']+)'/);
      if (missingArgMatch && card && card.id === missingArgMatch[2]) {
        try {
          if (card.args && Array.isArray(card.args)) {
            const schemaHint = card.args.map(a => `${a.name} (type: ${a.type}${a.required === false ? ', optional' : ', required'})`).join(', ');
            const enrichedMessage = `${error.message}. Expected args for this card: { ${schemaHint} }. Current args sent: ${JSON.stringify(args)}. Fix this card and retry.`;
            return { success: false, error: enrichedMessage };
          }
        } catch (enrichErr) {
          this.homey.error(`[runActionCard] Error enriching validation message:`, enrichErr);
        }
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Creates, updates, or deletes a Standard Homey Flow.
   *
   * @public
   * @param {Object} args - Arguments forwarded from the MCP tool call.
   * @returns {Promise<Object>} Result.
   */
  async manageFlow(args) {
    const { action, name, flowId, flowName, trigger, conditions = [], actions, enabled = true } = args;

    if (!action) {
      return { success: false, error: "Missing required parameter 'action'. Must be 'create', 'update', or 'delete'." };
    }

    if (trigger) {
      await this._normalizeCardArgs(trigger, 'manageFlow:trigger');
      delete trigger.ownerUri;
      delete trigger.uri;
    }
    if (conditions && Array.isArray(conditions)) {
      for (const cond of conditions) {
        if (cond) {
          await this._normalizeCardArgs(cond, 'manageFlow:condition');
          delete cond.ownerUri;
          delete cond.uri;
          if (cond.group === undefined || cond.group === null || cond.group === '') {
            cond.group = 'group1';
          }
        }
      }
    }
    if (actions && Array.isArray(actions)) {
      for (const act of actions) {
        if (act) {
          await this._normalizeCardArgs(act, 'manageFlow:action');
          delete act.ownerUri;
          delete act.uri;
        }
      }
    }

    try {
      await this.adapter.initialize();

      const _resolveStandardFlow = async (id, nameHint) => {
        const standardFlows = await this.adapter.api.flow.getFlows();
        if (id) {
          const f = standardFlows[id];
          if (!f) return { error: `Standard Flow with id "${id}" not found.` };
          return { flow: f };
        }
        if (!nameHint) return { error: "Provide 'flowId' or 'flowName' to identify the flow." };
        const f = Object.values(standardFlows).find(fl => fl.name.toLowerCase() === nameHint.toLowerCase());
        if (!f) {
          const advancedFlows = await this.adapter.api.flow.getAdvancedFlows();
          const adv = Object.values(advancedFlows).find(fl => fl.name.toLowerCase() === nameHint.toLowerCase());
          if (adv) return { error: `"${nameHint}" is an Advanced Flow. Advanced Flows cannot be modified via manage_flow.` };
          return { error: `Standard Flow "${nameHint}" not found. Call discover_flows to see available flows.` };
        }
        return { flow: f };
      };

      if (action === 'create') {
        if (!name) return { success: false, error: "Missing required parameter 'name' for action='create'." };
        if (!trigger) return { success: false, error: "Missing required parameter 'trigger' for action='create'." };
        if (!actions || actions.length === 0) return { success: false, error: "Parameter 'actions' must contain at least one item for action='create'." };

        const cardsToValidate = {};
        if (trigger) {
          cardsToValidate['trigger'] = { ...trigger, type: 'trigger' };
        }
        if (conditions && Array.isArray(conditions)) {
          conditions.forEach((c, idx) => {
            if (c) cardsToValidate[`condition_${idx}`] = { ...c, type: 'condition' };
          });
        }
        if (actions && Array.isArray(actions)) {
          actions.forEach((a, idx) => {
            if (a) cardsToValidate[`action_${idx}`] = { ...a, type: 'action' };
          });
        }

        const validationIssues = await this._validateAdvancedFlowCards(cardsToValidate, 'manageFlow');
        if (validationIssues.length > 0) {
          const issueDetails = validationIssues.map(v => {
            const schemaHint = v.requiredArgs.map(a => `${a.name} (${a.type})`).join(', ');
            const missing = v.missingArgs.map(a => `${a.name} (${a.type})`).join(', ');
            return `Card "${v.cardId}" [key: ${v.cardKey}]: missing required args [${missing}]. Full schema: { ${schemaHint} }`;
          }).join('\n');
          this.homey.log(`[FlowManager] [manageFlow] Pre-execution validation failed:\n${issueDetails}`);
          return {
            success: false,
            error: `Cannot create Standard Flow: one or more cards have missing required arguments. Fix all issues and retry in a single call:\n${issueDetails}`
          };
        }

        const flowObj = { name, enabled, trigger, conditions: conditions ?? [], actions };
        this.homey.log(`[FlowManager] Creating flow: ${name}`);

        const base64Str = Buffer.from(JSON.stringify(flowObj)).toString('base64');
        const code = `return await Homey.flow.createFlow({ flow: JSON.parse(Buffer.from("${base64Str}", "base64").toString("utf8")) });`;

        const created = await this._executeHomeyScript(code);
        return {
          success: true,
          flow: { id: created.id, name: created.name, enabled: created.enabled },
          message: `Standard Flow "${created.name}" created successfully (id: ${created.id})`
        };
      }

      if (action === 'update') {
        const { flow, error: resolveError } = await _resolveStandardFlow(flowId, flowName);
        if (resolveError) return { success: false, error: resolveError };

        await this._writeBackup(flow.id, flow, 'standard');

        const updates = {};
        if (name !== undefined) updates.name = name;
        if (trigger !== undefined) updates.trigger = trigger;
        if (conditions !== undefined) updates.conditions = conditions;
        if (actions !== undefined) updates.actions = actions;
        if (enabled !== undefined) updates.enabled = enabled;

        this.homey.log(`[FlowManager] Updating flow id=${flow.id} with keys: ${Object.keys(updates).join(', ')}`);
        const updatedFlowObj = { ...flow, ...updates };

        const base64Str = Buffer.from(JSON.stringify(updatedFlowObj)).toString('base64');
        const code = `return await Homey.flow.updateFlow({ id: "${flow.id}", flow: JSON.parse(Buffer.from("${base64Str}", "base64").toString("utf8")) });`;

        const updated = await this._executeHomeyScript(code);
        return {
          success: true,
          flow: { id: updated.id, name: updated.name, enabled: updated.enabled },
          message: `Standard Flow "${updated.name}" updated successfully`
        };
      }

      if (action === 'delete') {
        const { flow, error: resolveError } = await _resolveStandardFlow(flowId, flowName);
        if (resolveError) return { success: false, error: resolveError };

        await this._writeBackup(flow.id, flow, 'standard');

        this.homey.log(`[FlowManager] Deleting flow: ${flow.name} (id=${flow.id})`);
        await this._executeHomeyScript(`return await Homey.flow.deleteFlow({ id: "${flow.id}" });`);
        return {
          success: true,
          flow: { id: flow.id, name: flow.name },
          message: `Standard Flow "${flow.name}" deleted successfully`
        };
      }

      if (action === 'restore') {
        if (!flowId && !flowName) return { success: false, error: "Missing required parameter: 'flowId' or 'flowName' to restore." };
        
        let backupData = null;
        let originalId = flowId;
        
        if (flowId) {
          const backup = await this._readBackup(flowId);
          if (backup) {
            backupData = backup;
          } else if (flowName) {
            const res = await this._findBackupByName(flowName);
            if (res) {
              backupData = res.backup;
              originalId = res.originalId;
            }
          }
        } else if (flowName) {
          const res = await this._findBackupByName(flowName);
          if (res) {
            backupData = res.backup;
            originalId = res.originalId;
          }
        }

        if (!backupData) {
          return { success: false, error: `No backup found for flow ${flowId || flowName}.` };
        }

        if (backupData.type !== 'standard') {
          return { success: false, error: `Backup is of type ${backupData.type}. Please use manage_advanced_flow to restore this flow.` };
        }

        const flowToRestore = backupData.flow;
        const standardFlows = await this.adapter.api.flow.getFlows();
        const exists = !!standardFlows[originalId];

        const base64Str = Buffer.from(JSON.stringify(flowToRestore)).toString('base64');
        let restoredFlow;

        if (exists) {
          this.homey.log(`[FlowManager] Restoring existing flow id=${originalId}`);
          const code = `return await Homey.flow.updateFlow({ id: "${originalId}", flow: JSON.parse(Buffer.from("${base64Str}", "base64").toString("utf8")) });`;
          restoredFlow = await this._executeHomeyScript(code);
        } else {
          this.homey.log(`[FlowManager] Recreating deleted flow name="${flowToRestore.name}"`);
          const code = `return await Homey.flow.createFlow({ flow: JSON.parse(Buffer.from("${base64Str}", "base64").toString("utf8")) });`;
          restoredFlow = await this._executeHomeyScript(code);
          
          await this._writeBackup(restoredFlow.id, restoredFlow, 'standard');
          await this._deleteBackupFile(originalId);
        }

        return {
          success: true,
          flow: { id: restoredFlow.id, name: restoredFlow.name, enabled: restoredFlow.enabled },
          message: `Standard Flow "${restoredFlow.name}" restored successfully`
        };
      }

      return { success: false, error: `Unknown action '${action}'. Must be 'create', 'update', 'delete', or 'restore'.` };

    } catch (error) {
      this.homey.error(`[FlowManager] [manageFlow] Error:`, error);

      const missingArgMatch = error.message && error.message.match(/Missing argument '([^']+)' for card '([^']+)'/);
      if (missingArgMatch) {
        const missingArgName = missingArgMatch[1];
        const cardId = missingArgMatch[2];

        let offendingCard = null;
        let cardType = 'action';

        if (trigger && trigger.id === cardId) {
          offendingCard = trigger;
          cardType = 'trigger';
        } else if (conditions && Array.isArray(conditions)) {
          offendingCard = conditions.find(c => c && c.id === cardId);
          cardType = 'condition';
        } else if (actions && Array.isArray(actions)) {
          offendingCard = actions.find(a => a && a.id === cardId);
          cardType = 'action';
        }

        if (offendingCard) {
          try {
            const tempCard = { ...offendingCard };
            this._ensureCardUri(tempCard);
            let cardDef = null;
            if (cardType === 'trigger') {
              cardDef = await this.adapter.api.flow.getFlowCardTrigger({ id: tempCard.id, uri: tempCard.ownerUri }).catch(() => null);
            } else if (cardType === 'condition') {
              cardDef = await this.adapter.api.flow.getFlowCardCondition({ id: tempCard.id, uri: tempCard.ownerUri }).catch(() => null);
            } else {
              cardDef = await this.adapter.api.flow.getFlowCardAction({ id: tempCard.id, uri: tempCard.ownerUri }).catch(() => null);
            }
            if (cardDef && Array.isArray(cardDef.args)) {
              const schemaHint = cardDef.args.map(a => `${a.name} (type: ${a.type}${a.required === false ? ', optional' : ', required'})`).join(', ');
              const enrichedMessage = `${error.message}. Expected args for this card: { ${schemaHint} }. Current args sent: ${JSON.stringify(offendingCard.args)}. Fix this card and retry.`;
              return { success: false, error: enrichedMessage };
            }
          } catch (enrichErr) {
            this.homey.error(`[FlowManager] [manageFlow] Error enriching validation message:`, enrichErr);
          }
        }
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Creates, updates, or deletes an Advanced Flow in Homey Pro.
   *
   * @public
   * @param {Object} args - Arguments forwarded from the MCP tool call.
   * @returns {Promise<Object>} Result.
   */
  async manageAdvancedFlow(args) {
    let { action, name, flowId, flowName, cards, enabled = true } = args;

    if (!action) {
      return { success: false, error: "Missing required parameter 'action'. Must be 'create', 'update', or 'delete'." };
    }

    if (Array.isArray(cards)) {
      const cardsMap = {};
      for (const card of cards) {
        if (card && typeof card === 'object') {
          const uuid = card.uuid || `card_${Math.random().toString(36).substring(2, 11)}`;
          const cardCopy = { ...card };
          delete cardCopy.uuid;
          cardsMap[uuid] = cardCopy;
        }
      }
      cards = cardsMap;
    }

    if (cards && typeof cards === 'object') {
      for (const key of Object.keys(cards)) {
        const card = cards[key];
        if (!card || typeof card !== 'object') {
          delete cards[key];
          continue;
        }
        await this._normalizeCardArgs(card, 'manageAdvancedFlow');
        this._ensureCardUri(card);

        delete card.x;
        delete card.y;

        if (card.type === 'any' || card.type === 'all' || card.type === 'start' || card.type === 'delay') {
          delete card.id;
          delete card.ownerUri;
        }
      }
    }

    try {
      await this.adapter.initialize();

      const _resolveAdvancedFlow = async (id, nameHint) => {
        const advancedFlows = await this.adapter.api.flow.getAdvancedFlows();
        if (id) {
          const f = advancedFlows[id];
          if (!f) return { error: `Advanced Flow with id "${id}" not found.` };
          return { flow: f };
        }
        if (!nameHint) return { error: "Provide 'flowId' or 'flowName' to identify the flow." };
        const f = Object.values(advancedFlows).find(fl => fl.name.toLowerCase() === nameHint.toLowerCase());
        if (!f) {
          const standardFlows = await this.adapter.api.flow.getFlows();
          const std = Object.values(standardFlows).find(fl => fl.name.toLowerCase() === nameHint.toLowerCase());
          if (std) return { error: `"${nameHint}" is a Standard Flow. Standard Flows cannot be modified via manage_advanced_flow.` };
          return { error: `Advanced Flow "${nameHint}" not found. Call discover_flows to see available flows.` };
        }
        return { flow: f };
      };

      if (action === 'create') {
        if (!name) return { success: false, error: "Missing required parameter 'name' for action='create'." };
        if (!cards || Object.keys(cards).length === 0) {
          return { success: false, error: "Missing required parameter 'cards' for action='create'. Must contain at least one node." };
        }

        for (const card of Object.values(cards)) {
          delete card.action;
        }

        const finalizedCards = this._applyAdvancedFlowAutoLayout(cards);

        const validationIssues = await this._validateAdvancedFlowCards(finalizedCards, 'manageAdvancedFlow');
        if (validationIssues.length > 0) {
          const issueDetails = validationIssues.map(v => {
            const schemaHint = v.requiredArgs.map(a => `${a.name} (${a.type})`).join(', ');
            const missing = v.missingArgs.map(a => `${a.name} (${a.type})`).join(', ');
            return `Card "${v.cardId}" [key: ${v.cardKey}]: missing required args [${missing}]. Full schema: { ${schemaHint} }`;
          }).join('\n');
          this.homey.log(`[FlowManager] [manageAdvancedFlow] Pre-execution validation failed:\n${issueDetails}`);
          return {
            success: false,
            error: `Cannot create Advanced Flow: one or more cards have missing required arguments. Fix all issues and retry in a single call:\n${issueDetails}`
          };
        }

        const advancedflow = { name, enabled, cards: finalizedCards };
        this.homey.log(`[FlowManager] Creating advanced flow: ${name}`);

        const base64Str = Buffer.from(JSON.stringify(advancedflow)).toString('base64');
        const code = `return await Homey.flow.createAdvancedFlow({ advancedflow: JSON.parse(Buffer.from("${base64Str}", "base64").toString("utf8")) });`;

        const created = await this._executeHomeyScript(code);
        return {
          success: true,
          flow: { id: created.id, name: created.name, enabled: created.enabled },
          message: `Advanced Flow "${created.name}" created successfully (id: ${created.id})`
        };
      }

      if (action === 'update') {
        const { flow, error: resolveError } = await _resolveAdvancedFlow(flowId, flowName);
        if (resolveError) return { success: false, error: resolveError };

        await this._writeBackup(flow.id, flow, 'advanced');

        const updates = {};
        if (name !== undefined) updates.name = name;
        if (enabled !== undefined) updates.enabled = enabled;
        if (cards !== undefined) {
          const mergedCards = { ...(flow.cards || {}) };
          for (const [uuid, cardNode] of Object.entries(cards)) {
            const cardAction = cardNode.action || (mergedCards[uuid] ? 'update' : 'create');
            delete cardNode.action;

            if (cardAction === 'delete') {
              delete mergedCards[uuid];
            } else if (cardAction === 'update') {
              if (mergedCards[uuid]) {
                const existingArgs = mergedCards[uuid].args || {};
                const newArgs = cardNode.args || {};
                mergedCards[uuid] = {
                  ...mergedCards[uuid],
                  ...cardNode,
                  args: { ...existingArgs, ...newArgs }
                };
              } else {
                mergedCards[uuid] = cardNode;
              }
            } else if (cardAction === 'create') {
              mergedCards[uuid] = cardNode;
            }
          }
          const finalizedCards = this._applyAdvancedFlowAutoLayout(mergedCards);
          updates.cards = finalizedCards;
        }

        this.homey.log(`[FlowManager] Updating advanced flow id=${flow.id} with keys: ${Object.keys(updates).join(', ')}`);
        const updatedFlowObj = { ...flow, ...updates };

        const base64Str = Buffer.from(JSON.stringify(updatedFlowObj)).toString('base64');
        const code = `return await Homey.flow.updateAdvancedFlow({ id: "${flow.id}", advancedflow: JSON.parse(Buffer.from("${base64Str}", "base64").toString("utf8")) });`;

        const updated = await this._executeHomeyScript(code);
        return {
          success: true,
          flow: { id: updated.id, name: updated.name, enabled: updated.enabled },
          message: `Advanced Flow "${updated.name}" updated successfully`
        };
      }

      if (action === 'delete') {
        const { flow, error: resolveError } = await _resolveAdvancedFlow(flowId, flowName);
        if (resolveError) return { success: false, error: resolveError };

        await this._writeBackup(flow.id, flow, 'advanced');

        this.homey.log(`[FlowManager] Deleting advanced flow: ${flow.name} (id=${flow.id})`);
        await this._executeHomeyScript(`return await Homey.flow.deleteAdvancedFlow({ id: "${flow.id}" });`);
        return {
          success: true,
          flow: { id: flow.id, name: flow.name },
          message: `Advanced Flow "${flow.name}" deleted successfully`
        };
      }

      if (action === 'restore') {
        if (!flowId && !flowName) return { success: false, error: "Missing required parameter: 'flowId' or 'flowName' to restore." };
        
        let backupData = null;
        let originalId = flowId;
        
        if (flowId) {
          const backup = await this._readBackup(flowId);
          if (backup) {
            backupData = backup;
          } else if (flowName) {
            const res = await this._findBackupByName(flowName);
            if (res) {
              backupData = res.backup;
              originalId = res.originalId;
            }
          }
        } else if (flowName) {
          const res = await this._findBackupByName(flowName);
          if (res) {
            backupData = res.backup;
            originalId = res.originalId;
          }
        }

        if (!backupData) {
          return { success: false, error: `No backup found for flow ${flowId || flowName}.` };
        }

        if (backupData.type !== 'advanced') {
          return { success: false, error: `Backup is of type ${backupData.type}. Please use manage_flow to restore this flow.` };
        }

        const flowToRestore = backupData.flow;
        const advancedFlows = await this.adapter.api.flow.getAdvancedFlows();
        const exists = !!advancedFlows[originalId];

        const base64Str = Buffer.from(JSON.stringify(flowToRestore)).toString('base64');
        let restoredFlow;

        if (exists) {
          this.homey.log(`[FlowManager] Restoring existing advanced flow id=${originalId}`);
          const code = `return await Homey.flow.updateAdvancedFlow({ id: "${originalId}", advancedflow: JSON.parse(Buffer.from("${base64Str}", "base64").toString("utf8")) });`;
          restoredFlow = await this._executeHomeyScript(code);
        } else {
          this.homey.log(`[FlowManager] Recreating deleted advanced flow name="${flowToRestore.name}"`);
          const code = `return await Homey.flow.createAdvancedFlow({ advancedflow: JSON.parse(Buffer.from("${base64Str}", "base64").toString("utf8")) });`;
          restoredFlow = await this._executeHomeyScript(code);
          
          await this._writeBackup(restoredFlow.id, restoredFlow, 'advanced');
          await this._deleteBackupFile(originalId);
        }

        return {
          success: true,
          flow: { id: restoredFlow.id, name: restoredFlow.name, enabled: restoredFlow.enabled },
          message: `Advanced Flow "${restoredFlow.name}" restored successfully`
        };
      }

      return { success: false, error: `Unknown action '${action}'. Must be 'create', 'update', 'delete', or 'restore'.` };

    } catch (error) {
      this.homey.error(`[FlowManager] [manageAdvancedFlow] Error:`, error);

      const missingArgMatch = error.message && error.message.match(/Missing argument '([^']+)' for card '([^']+)'/);
      if (missingArgMatch && cards && typeof cards === 'object') {
        const missingArgName = missingArgMatch[1];
        const cardId = missingArgMatch[2];
        const offendingCard = Object.values(cards).find(c => c && c.id === cardId);
        if (offendingCard) {
          try {
            this._ensureCardUri(offendingCard);
            const cardType = offendingCard.type || 'action';
            let cardDef = null;
            if (cardType === 'trigger') {
              cardDef = await this.adapter.api.flow.getFlowCardTrigger({ id: offendingCard.id, uri: offendingCard.ownerUri }).catch(() => null);
            } else if (cardType === 'condition') {
              cardDef = await this.adapter.api.flow.getFlowCardCondition({ id: offendingCard.id, uri: offendingCard.ownerUri }).catch(() => null);
            } else {
              cardDef = await this.adapter.api.flow.getFlowCardAction({ id: offendingCard.id, uri: offendingCard.ownerUri }).catch(() => null);
            }
            if (cardDef && Array.isArray(cardDef.args)) {
              const schemaHint = cardDef.args.map(a => `${a.name} (type: ${a.type}${a.required === false ? ', optional' : ', required'})`).join(', ');
              const enrichedMessage = `${error.message}. Expected args for this card: { ${schemaHint} }. Current args sent: ${JSON.stringify(offendingCard.args)}. Fix this card and retry.`;
              return { success: false, error: enrichedMessage };
            }
          } catch (enrichErr) {
            this.homey.error(`[FlowManager] [manageAdvancedFlow] Error enriching validation message:`, enrichErr);
          }
        }
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Retrieves the complete internal structure of a Homey Flow (Standard or Advanced).
   *
   * @public
   * @param {string} [flowId] - Unique UUID of the flow.
   * @param {string} [flowName] - Exact name of the flow (case-insensitive).
   * @returns {Promise<Object>} Details.
   */
  async discoverFlowDetails(flowId, flowName) {
    if (!flowId && !flowName) {
      return { success: false, error: "Provide either 'flowId' or 'flowName' to retrieve flow details." };
    }

    try {
      await this.adapter.initialize();

      const standardFlows = await this.adapter.api.flow.getFlows();
      const advancedFlows = await this.adapter.api.flow.getAdvancedFlows();

      let flow = null;
      let flowType = 'standard';

      if (flowId) {
        flow = standardFlows[flowId];
        if (!flow) {
          flow = advancedFlows[flowId];
          if (flow) flowType = 'advanced';
        }
      } else {
        flow = Object.values(standardFlows).find(f => f.name.toLowerCase() === flowName.toLowerCase());
        if (!flow) {
          flow = Object.values(advancedFlows).find(f => f.name.toLowerCase() === flowName.toLowerCase());
          if (flow) flowType = 'advanced';
        }
      }

      if (!flow) {
        const allNames = [
          ...Object.values(standardFlows).map(f => f.name),
          ...Object.values(advancedFlows).map(f => f.name)
        ];
        const suggestion = this._suggestDeviceClass(flowId || flowName, allNames);
        return {
          success: false,
          error: `Flow not found.${suggestion ? ` Did you mean "${suggestion}"?` : ''} Use discover_flows to obtain a valid flow ID or name.`,
          suggestion: suggestion || null
        };
      }

      this.homey.log(`[FlowManager] Inspecting ${flowType} flow: ${flow.name} (id=${flow.id})`);

      const cleaned = flowType === 'standard'
        ? this._cleanStandardFlow(flow)
        : this._cleanAdvancedFlow(flow);

      return {
        success: true,
        type: flowType,
        flow: cleaned,
        message: `Successfully retrieved details for ${flowType} Flow "${flow.name}"`
      };

    } catch (error) {
      this.homey.error('[FlowManager] [discoverFlowDetails] Error:', error);
      return { success: false, error: error.message };
    }
  }

  // --- Private Methods ---

  /**
   * Ensures a HomeyScript proxy script exists and returns its ID.
   *
   * @private
   * @returns {Promise<{scriptId: string}>} Script ID.
   */
  async _ensureHomeyScriptProxy() {
    await this.adapter.initialize();

    if (!this._homeyScriptProxyId) {
      try {
        const response = await fetch(`${this.adapter._localUrl}/api/app/com.athom.homeyscript/script`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${this.adapter._sessionToken}`, 'Content-Type': 'application/json' },
        });

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error('HomeyScript app is NOT installed. Please tell the user that HomeyScript must be installed from the Homey App Store to enable flow triggering and advanced device actions.');
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const scripts = await response.json();
        const existing = Object.values(scripts).find(s => s.name === 'GeminiAI-FlowTrigger');
        if (existing) {
          this._homeyScriptProxyId = existing.id;
          this.homey.log('[FlowManager] Found existing HomeyScript proxy:', this._homeyScriptProxyId);
        }
      } catch (e) {
        if (e.message.includes('HomeyScript app is NOT installed')) throw e;
        this.homey.log('[FlowManager] Could not list HomeyScript scripts:', e.message);
      }

      if (!this._homeyScriptProxyId) {
        try {
          const response = await fetch(`${this.adapter._localUrl}/api/app/com.athom.homeyscript/script`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${this.adapter._sessionToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: 'GeminiAI-FlowTrigger',
              code: '// Flow trigger proxy for GeminiAI app\n// Do not delete — used by com.dimapp.geminiai\n',
            }),
          });

          if (!response.ok) {
            if (response.status === 404) {
              throw new Error('HomeyScript app is NOT installed. Please tell the user that HomeyScript must be installed from the Homey App Store to enable flow triggering and advanced device actions.');
            }
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const newScript = await response.json();
          this._homeyScriptProxyId = newScript.id;
          this.homey.log('[FlowManager] Created HomeyScript proxy:', this._homeyScriptProxyId);
        } catch (e) {
          if (e.message.includes('HomeyScript app is NOT installed')) throw e;
          throw new Error(`Failed to create HomeyScript proxy script: ${e.message}`);
        }
      }
    }

    return { scriptId: this._homeyScriptProxyId };
  }

  /**
   * Triggers a flow via the HomeyScript proxy.
   *
   * @private
   * @param {string} flowId - The flow UUID.
   * @param {string} flowType - 'standard' or 'advanced'.
   * @param {Object} [args={}] - Flow arguments.
   * @returns {Promise<void>}
   */
  async _triggerFlowViaHomeyScript(flowId, flowType, args = {}) {
    const method = flowType === 'advanced' ? 'triggerAdvancedFlow' : 'triggerFlow';
    const argsStr = args && Object.keys(args).length > 0 ? JSON.stringify(args) : 'null';
    const code = `await Homey.flow.${method}({ id: \"${flowId}\" }, ${argsStr});`;

    this.homey.log(`[FlowManager] Executing via HomeyScript: ${code}`);
    await this._executeHomeyScript(code);
  }

  /**
   * Executes a device action card via the HomeyScript proxy.
   *
   * @private
   * @param {string} cardId - The action card ID.
   * @param {string} deviceUri - Device URI.
   * @param {Object} args - Action arguments.
   * @returns {Promise<*>} Result.
   */
  async _runActionCardViaHomeyScript(cardId, deviceUri, args) {
    const argsJson = JSON.stringify(args).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const code = `return await Homey.flow.runFlowCardAction({ id: "${cardId}", uri: "${deviceUri}", args: JSON.parse("${argsJson}") });`;

    this.homey.log(`[FlowManager] Executing action via HomeyScript: ${cardId}`);
    return await this._executeHomeyScript(code);
  }

  /**
   * Fetches the device image.
   *
   * @private
   * @param {string} deviceId - Device UUID.
   * @returns {Promise<Object|null>} Image data.
   */
  async _fetchDeviceImage(deviceId) {
    try {
      await this.adapter.initialize();
      const devices = await this.adapter.api.devices.getDevices();
      const device = Object.values(devices).find(d => d.id === deviceId);

      if (!device) throw new Error(`Device ${deviceId} not found`);
      if (!device.images || device.images.length === 0) {
        this.homey.log(`[FlowManager] Device has no images array or empty`);
        return null;
      }

      const response = await fetch(`${this.adapter._localUrl}/api/manager/images/image`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.adapter._sessionToken}`, 'Content-Type': 'application/json' },
      });

      if (!response.ok) throw new Error(`Failed to fetch images: HTTP ${response.status}`);

      const allImages = await response.json();
      const deviceImageIds = device.images
        .filter(img => img.imageObj && img.imageObj.id)
        .map(img => img.imageObj.id);

      const deviceImages = Object.values(allImages).filter(img => deviceImageIds.includes(img.id));

      if (deviceImages.length === 0) {
        this.homey.log(`[FlowManager] No matching images found after filtering`);
        return null;
      }

      const latestImage = deviceImages.sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated))[0];

      const imageResponse = await fetch(`${this.adapter._localUrl}${latestImage.url}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.adapter._sessionToken}` },
      });

      if (!imageResponse.ok) throw new Error(`Failed to download image: HTTP ${imageResponse.status}`);

      const imageBuffer = await imageResponse.arrayBuffer();
      const bufferSize = imageBuffer.byteLength;

      const MAX_IMAGE_SIZE = 4 * 1024 * 1024;
      if (bufferSize > MAX_IMAGE_SIZE) {
        throw new Error(`Image too large: ${(bufferSize / 1024 / 1024).toFixed(2)} MB (max 4MB)`);
      }

      const imageBase64 = Buffer.from(imageBuffer).toString('base64');
      const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';

      this.homey.log(`[FlowManager] Fetched image for device ${deviceId}: ${(bufferSize / 1024).toFixed(2)} KB, type: ${mimeType}`);

      return { imageBase64, mimeType, imageId: latestImage.id, lastUpdated: latestImage.lastUpdated };

    } catch (error) {
      this.homey.error(`[FlowManager] Error fetching device image:`, error);
      return null;
    }
  }

  /**
   * Resolves a device by ID or name.
   *
   * @private
   * @param {string} deviceName - Device name.
   * @param {string} deviceId - Device UUID.
   * @returns {Promise<Object>} Device response.
   */
  async _resolveDevice(deviceName, deviceId) {
    const devices = await this.adapter.api.devices.getDevices();
    const zones = await this.adapter.api.zones.getZones();
    const deviceList = Object.values(devices);

    if (deviceId) {
      const device = deviceList.find(d => d.id === deviceId);
      if (!device) {
        throw new Error(`Device with ID "${deviceId}" not found.`);
      }
      return { success: true, device };
    }

    if (!deviceName) {
      throw new Error("Missing required parameter: provide 'deviceName' or 'deviceId'.");
    }

    const matches = deviceList.filter(d => d.name.toLowerCase() === deviceName.toLowerCase());

    if (matches.length === 0) {
      const err = new Error(`Device "${deviceName}" not found.`);
      err.notFound = true;
      throw err;
    }

    if (matches.length > 1) {
      const err = new Error(`Multiple devices named "${deviceName}" found.`);
      err.ambiguous = true;
      err.matches = matches.map(d => ({
        name: d.name,
        id: d.id,
        zone: d.zone && zones[d.zone] ? zones[d.zone].name : 'Unknown'
      }));
      throw err;
    }

    return { success: true, device: matches[0] };
  }

  /**
   * Returns child zone IDs recursively.
   *
   * @private
   * @param {string} rootZoneId - Parent ID.
   * @param {Object} zones - Zones map.
   * @returns {string[]} IDs list.
   */
  _getAllChildZoneIds(rootZoneId, zones) {
    const ids = [rootZoneId];
    const children = Object.values(zones).filter(z => z.parent === rootZoneId);
    for (const child of children) {
      ids.push(...this._getAllChildZoneIds(child.id, zones));
    }
    return ids;
  }

  /**
   * Suggests closest device class.
   *
   * @private
   * @param {string} input - Term.
   * @param {string[]} available - Available terms.
   * @returns {string|null} Suggestion.
   */
  _suggestDeviceClass(input, available) {
    if (!input || !available || available.length === 0) return null;
    const inputLower = input.toLowerCase();

    const exact = available.find(cls => cls.toLowerCase() === inputLower);
    if (exact) return exact;

    const partial = available.find(cls =>
      cls.toLowerCase().includes(inputLower) || inputLower.includes(cls.toLowerCase())
    );
    return partial || null;
  }

  /**
   * Suggests capability.
   *
   * @private
   * @param {string} input - Capability term.
   * @param {string[]} available - Available capabilities.
   * @returns {string|null} Suggestion.
   */
  _suggestCapability(input, available) {
    if (!input || !available || available.length === 0) return null;
    const inputLower = input.toLowerCase();

    let match = available.find(cap => cap.toLowerCase().includes(inputLower));
    if (match) return match;

    match = available.find(cap => inputLower.includes(cap.toLowerCase()));
    if (match) return match;

    let minDistance = Infinity;
    let suggestion = null;
    for (const cap of available) {
      const distance = this._levenshteinDistance(inputLower, cap.toLowerCase());
      if (distance < minDistance && distance <= 3) {
        minDistance = distance;
        suggestion = cap;
      }
    }
    return suggestion;
  }

  /**
   * Calculates Levenshtein distance.
   *
   * @private
   * @param {string} a - String a.
   * @param {string} b - String b.
   * @returns {number} Distance.
   */
  _levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  /**
   * Ensures missing card URIs are reconstructed.
   *
   * @private
   * @param {Object} card - Card object.
   * @returns {void}
   */
  _ensureCardUri(card) {
    if (!card || !card.id || typeof card.id !== 'string') return;
    if (card.ownerUri && typeof card.ownerUri === 'string' && card.ownerUri.trim().length > 0) return;

    const parts = card.id.split(':');
    if (parts.length > 1) {
      card.ownerUri = parts.slice(0, -1).join(':');
      this.homey.log(`[_ensureCardUri] Reconstructed missing ownerUri: "${card.ownerUri}" from card.id: "${card.id}"`);
    }
  }

  /**
   * Infers argument key based on card ID.
   *
   * @private
   * @param {string} cardId - Card ID.
   * @returns {string} Key name.
   */
  _inferFirstArgKey(cardId) {
    if (!cardId || typeof cardId !== 'string') return 'text';

    const id = cardId.toLowerCase();

    if (id.includes('echo-speak') || id.includes('echo_speak') || id.includes('say')) return 'message';
    if (id.includes('alexa-command') || id.endsWith(':command') || id.includes('alexa_command')) return 'command';
    if (id.includes('speak') && !id.includes('echo')) return 'message';
    if (id.includes('tts') || id.includes('text_to_speech')) return 'text';
    if (id.includes('com.dimapp.geminiai')) return 'prompt';
    if (id.includes('notification')) return 'text';
    if (id.includes('time_exactly') || id.includes('cron:time')) return 'time';
    if (id.includes('logic') && id.includes('set')) return 'value';

    return 'text';
  }

  /**
   * Normalizes card arguments dynamically.
   *
   * @private
   * @param {Object} card - Card object.
   * @param {string} contextLabel - Logging label.
   * @returns {Promise<void>}
   */
  async _normalizeCardArgs(card, contextLabel) {
    if (!card) return;
    if (card.args === null) {
      card.args = {};
    }
    if (card.args === undefined) return;

    if (typeof card.args === 'string') {
      try {
        const parsed = JSON.parse(card.args);
        card.args = parsed;
        this.homey.log(`[FlowManager] [${contextLabel}] [normalize] Card (${card.id}): args was a JSON string, parsed into object.`);
      } catch (e) {
        try {
          const parsed = (new Function(`return (${card.args})`))();
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            card.args = parsed;
            this.homey.log(`[FlowManager] [${contextLabel}] [normalize] Card (${card.id}): args was a JS object literal, parsed via fallback.`);
          } else {
            throw new Error('Not a plain object');
          }
        } catch (fallbackError) {
          this.homey.log(`[FlowManager] [${contextLabel}] [normalize] Card (${card.id}): args is non-parseable. Wrapping as { text: "..." }.`);
          card.args = { text: card.args };
        }
      }
    }

    if (Array.isArray(card.args)) {
      if (card.args.length === 1 && typeof card.args[0] === 'object' && card.args[0] !== null && !Array.isArray(card.args[0])) {
        this.homey.log(`[FlowManager] [${contextLabel}] [normalize] Card (${card.id}): args was a single-object array. Extracting object.`);
        card.args = card.args[0];
      } else {
        const argKey = this._inferFirstArgKey(card.id);
        const value = card.args.length > 0 ? card.args[0] : null;
        this.homey.log(`[FlowManager] [${contextLabel}] [normalize] Card (${card.id}): args was an array ${JSON.stringify(card.args)}. Inferring key="${argKey}", reconstructing.`);
        card.args = value !== null ? { [argKey]: value } : {};
      }
    }

    if (card.args && typeof card.args === 'object' && !Array.isArray(card.args)) {
      try {
        await this.adapter.initialize();
        this._ensureCardUri(card);
        const cardType = card.type || 'action';
        let cardDef = null;

        if (cardType === 'trigger') {
          cardDef = await this.adapter.api.flow.getFlowCardTrigger({ id: card.id, uri: card.ownerUri }).catch(() => null);
        } else if (cardType === 'condition') {
          cardDef = await this.adapter.api.flow.getFlowCardCondition({ id: card.id, uri: card.ownerUri }).catch(() => null);
        } else {
          cardDef = await this.adapter.api.flow.getFlowCardAction({ id: card.id, uri: card.ownerUri }).catch(() => null);
        }

        if (cardDef && Array.isArray(cardDef.args)) {
          for (const argDef of cardDef.args) {
            const argName = argDef.name;
            const argType = argDef.type;
            const rawVal = card.args[argName];

            if (rawVal === undefined) continue;

            switch (argType) {
              case 'text':
              case 'date':
              case 'time':
              case 'color': {
                if (typeof rawVal !== 'string') {
                  const coerced = String(rawVal);
                  this.homey.log(`[FlowManager] [${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="${argType}" coerced ${JSON.stringify(rawVal)} -> "${coerced}".`);
                  card.args[argName] = coerced;
                }
                break;
              }

              case 'number': {
                const num = Number(rawVal);
                if (isNaN(num)) {
                  this.homey.log(`[FlowManager] [${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="number" could not parse "${rawVal}", removing.`);
                  delete card.args[argName];
                  break;
                }
                let clamped = num;
                if (argDef.min !== undefined && clamped < argDef.min) clamped = argDef.min;
                if (argDef.max !== undefined && clamped > argDef.max) clamped = argDef.max;
                if (clamped !== rawVal) {
                  this.homey.log(`[FlowManager] [${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="number" coerced ${JSON.stringify(rawVal)} -> ${clamped}.`);
                }
                card.args[argName] = clamped;
                break;
              }

              case 'range': {
                const flt = parseFloat(rawVal);
                if (isNaN(flt)) {
                  this.homey.log(`[FlowManager] [${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="range" could not parse "${rawVal}", removing.`);
                  delete card.args[argName];
                  break;
                }
                let clampedFlt = flt;
                const rMin = argDef.min !== undefined ? argDef.min : 0;
                const rMax = argDef.max !== undefined ? argDef.max : 1;
                if (clampedFlt < rMin) clampedFlt = rMin;
                if (clampedFlt > rMax) clampedFlt = rMax;
                if (clampedFlt !== rawVal) {
                  this.homey.log(`[FlowManager] [${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="range" coerced ${JSON.stringify(rawVal)} -> ${clampedFlt}.`);
                }
                card.args[argName] = clampedFlt;
                break;
              }

              case 'checkbox': {
                let bool;
                if (typeof rawVal === 'boolean') {
                  bool = rawVal;
                } else if (typeof rawVal === 'string') {
                  bool = rawVal.toLowerCase() === 'true' || rawVal === '1';
                } else {
                  bool = Boolean(rawVal);
                }
                if (bool !== rawVal) {
                  this.homey.log(`[FlowManager] [${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="checkbox" coerced ${JSON.stringify(rawVal)} -> ${bool}.`);
                }
                card.args[argName] = bool;
                break;
              }

              case 'dropdown': {
                const allowedValues = Array.isArray(argDef.values) ? argDef.values : [];
                if (allowedValues.length === 0) break;

                const candidateId = (typeof rawVal === 'object' && rawVal !== null && rawVal.id)
                  ? String(rawVal.id)
                  : String(rawVal);

                const exactMatch = allowedValues.find(v => v.id === candidateId);
                if (exactMatch) {
                  if (card.args[argName] !== candidateId) {
                    this.homey.log(`[FlowManager] [${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="dropdown" normalized to id "${candidateId}".`);
                    card.args[argName] = candidateId;
                  }
                  break;
                }

                const labelMatch = allowedValues.find(v => {
                  const label = v.label || v.title;
                  const labelText = label && typeof label === 'object' ? (label.en || Object.values(label)[0]) : String(label || '');
                  return labelText.toLowerCase() === candidateId.toLowerCase();
                });
                if (labelMatch) {
                  this.homey.log(`[FlowManager] [${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="dropdown" resolved label "${candidateId}" -> id "${labelMatch.id}".`);
                  card.args[argName] = labelMatch.id;
                  break;
                }

                this.homey.log(`[FlowManager] [${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="dropdown" no match, falling back to "${allowedValues[0].id}".`);
                card.args[argName] = allowedValues[0].id;
                break;
              }

              case 'multiselect': {
                const allowedMs = Array.isArray(argDef.values) ? argDef.values : [];
                const allowedIds = allowedMs.map(v => v.id);

                let candidates;
                if (Array.isArray(rawVal)) {
                  candidates = rawVal.map(v => (typeof v === 'object' && v !== null && v.id) ? String(v.id) : String(v));
                } else {
                  candidates = [String(rawVal)];
                }

                const valid = allowedIds.length > 0
                  ? candidates.filter(c => allowedIds.includes(c))
                  : candidates;

                this.homey.log(`[FlowManager] [${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="multiselect" resolved to [${valid.join(', ')}].`);
                card.args[argName] = valid;
                break;
              }

              case 'device':
              case 'autocomplete': {
                if (typeof rawVal === 'string' && rawVal.trim().length > 0) {
                  this.homey.log(`[FlowManager] [${contextLabel}] [autocomplete] Resolving string "${rawVal}" for arg "${argName}" (type="${argType}") on card ${card.id}.`);

                  const options = await this.adapter.api.flow.getFlowCardAutocomplete({
                    id: card.id,
                    uri: card.ownerUri,
                    type: cardType,
                    name: argName,
                    query: rawVal
                  }).catch(err => {
                    this.homey.error(`[FlowManager] [${contextLabel}] Autocomplete fetch failed for arg "${argName}":`, err.message);
                    return null;
                  });

                  if (Array.isArray(options) && options.length > 0) {
                    const match = options.find(opt => opt && opt.name && opt.name.toLowerCase() === rawVal.toLowerCase())
                                || options[0];
                    if (match) {
                      card.args[argName] = match;
                      this.homey.log(`[FlowManager] [${contextLabel}] [autocomplete] Resolved "${rawVal}" -> ${JSON.stringify(match)}.`);
                    }
                  }
                }
                break;
              }

              default:
                break;
            }
          }
        }
      } catch (err) {
        this.homey.error(`[FlowManager] [${contextLabel}] [normalize] Error during schema-driven normalization:`, err);
      }
    }
  }

  /**
   * Validates required arguments of all cards prior to creating or updating flow.
   *
   * @private
   * @param {Object} cards - Cards map.
   * @param {string} contextLabel - Context tag.
   * @returns {Promise<Array>} Validation failures.
   */
  async _validateAdvancedFlowCards(cards, contextLabel) {
    if (!cards || typeof cards !== 'object') return [];

    const issues = [];

    for (const [cardKey, card] of Object.entries(cards)) {
      if (!card || !card.id) continue;

      try {
        this._ensureCardUri(card);
        const cardType = card.type || 'action';
        let cardDef = null;

        if (cardType === 'trigger') {
          cardDef = await this.adapter.api.flow.getFlowCardTrigger({ id: card.id, uri: card.ownerUri }).catch(() => null);
        } else if (cardType === 'condition') {
          cardDef = await this.adapter.api.flow.getFlowCardCondition({ id: card.id, uri: card.ownerUri }).catch(() => null);
        } else {
          cardDef = await this.adapter.api.flow.getFlowCardAction({ id: card.id, uri: card.ownerUri }).catch(() => null);
        }

        if (!cardDef || !Array.isArray(cardDef.args)) continue;

        const requiredArgs = cardDef.args.filter(a => a.required !== false);
        const missingArgs = [];

        for (const argDef of requiredArgs) {
          const val = card.args && card.args[argDef.name];
          const isToken = typeof val === 'string' && /^\[\[.+]]$/.test(val.trim());
          if (isToken) continue;

          const isEmpty = val === undefined || val === null || val === '' || val === 'null';
          if (isEmpty) {
            missingArgs.push({ name: argDef.name, type: argDef.type });
          }
        }

        if (missingArgs.length > 0) {
          issues.push({
            cardKey,
            cardId: card.id,
            missingArgs,
            requiredArgs: requiredArgs.map(a => ({ name: a.name, type: a.type }))
          });
          this.homey.log(`[FlowManager] [${contextLabel}] [pre-validation] Card "${card.id}" [key: ${cardKey}]: missing args: ${missingArgs.map(a => a.name).join(', ')}`);
        }
      } catch (err) {
        this.homey.error(`[FlowManager] [${contextLabel}] [pre-validation] Error validating card "${card.id}":`, err);
      }
    }

    return issues;
  }

  /**
   * Dynamic auto layout positioning using graph BFS.
   *
   * @private
   * @param {Object} cards - Advanced flow cards map.
   * @returns {Object} Layout applied map.
   */
  _applyAdvancedFlowAutoLayout(cards) {
    if (!cards || typeof cards !== 'object') return cards;

    const uuids = Object.keys(cards);
    const children = {};
    const incoming = {};

    uuids.forEach(uuid => {
      children[uuid] = [];
      incoming[uuid] = 0;
    });

    uuids.forEach(uuid => {
      const card = cards[uuid];
      const outputs = [
        ...(card.outputSuccess || []),
        ...(card.outputError || []),
        ...(card.outputTrue || []),
        ...(card.outputFalse || [])
      ];

      outputs.forEach(childUuid => {
        if (children[uuid] && !children[uuid].includes(childUuid)) {
          children[uuid].push(childUuid);
        }
        if (incoming[childUuid] !== undefined) {
          incoming[childUuid]++;
        }
      });
    });

    const queue = [];
    const levels = {};

    uuids.forEach(uuid => {
      if (incoming[uuid] === 0 || cards[uuid].type === 'trigger') {
        queue.push({ uuid, level: 0 });
        levels[uuid] = 0;
      }
    });

    if (queue.length === 0 && uuids.length > 0) {
      queue.push({ uuid: uuids[0], level: 0 });
      levels[uuids[0]] = 0;
    }

    let steps = 0;
    const maxSteps = 1000;
    while (queue.length > 0 && steps < maxSteps) {
      steps++;
      const { uuid, level } = queue.shift();
      const currentLevel = Math.max(levels[uuid] || 0, level);
      levels[uuid] = currentLevel;

      const nextLevel = currentLevel + 1;
      (children[uuid] || []).forEach(childUuid => {
        if (levels[childUuid] === undefined || levels[childUuid] < nextLevel) {
          levels[childUuid] = nextLevel;
          queue.push({ uuid: childUuid, level: nextLevel });
        }
      });
    }

    uuids.forEach(uuid => {
      if (levels[uuid] === undefined) {
        levels[uuid] = 0;
      }
    });

    const levelGroups = {};
    uuids.forEach(uuid => {
      const lvl = levels[uuid];
      if (!levelGroups[lvl]) {
        levelGroups[lvl] = [];
      }
      levelGroups[lvl].push(uuid);
    });

    const getCardWidth = (type) => {
      if (type === 'start') return 50;
      if (type === 'any' || type === 'all') return 90;
      if (type === 'delay') return 110;
      return 280;
    };

    const xCoords = {};
    xCoords[0] = 50;

    const sortedLevels = Object.keys(levelGroups)
      .map(Number)
      .sort((a, b) => a - b);

    const GAP_BETWEEN_CARDS = 120;

    for (let i = 0; i < sortedLevels.length - 1; i++) {
      const currentLvl = sortedLevels[i];
      const nextLvl = sortedLevels[i + 1];

      const currentCards = levelGroups[currentLvl].map(uuid => cards[uuid]);
      const maxWidth = Math.max(...currentCards.map(card => getCardWidth(card.type)));

      xCoords[nextLvl] = xCoords[currentLvl] + maxWidth + GAP_BETWEEN_CARDS;
    }

    Object.entries(levelGroups).forEach(([lvlStr, group]) => {
      const lvl = parseInt(lvlStr, 10);
      const xCoord = xCoords[lvl] ?? (50 + lvl * 450);
      const count = group.length;

      group.forEach((uuid, index) => {
        const card = cards[uuid];
        const yCoord = 400 - ((count - 1) / 2) * 160 + index * 160;

        if (card.x === undefined || card.x === null) {
          card.x = xCoord;
        }
        if (card.y === undefined || card.y === null) {
          card.y = Math.round(yCoord);
        }
      });
    });

    return cards;
  }

  /**
   * Executes arbitrary code via the HomeyScript proxy.
   *
   * @private
   * @param {string} code - The JavaScript code to execute.
   * @returns {Promise<*>} The result of the script execution.
   */
  async _executeHomeyScript(code) {
    const { scriptId } = await this._ensureHomeyScriptProxy();
    const response = await fetch(`${this.adapter._localUrl}/api/app/com.athom.homeyscript/script/${scriptId}/run`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.adapter._sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('HomeyScript proxy script not found or HomeyScript is not installed. Please tell the user that HomeyScript must be installed from the Homey App Store to enable advanced device actions and flow management.');
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    if (!result.success) {
      throw new Error(result.returns?.message || result.error || 'HomeyScript execution failed');
    }
    return result.returns;
  }

  /**
   * Resolves path for backup.
   *
   * @private
   * @param {string} flowId - Flow ID.
   * @returns {string} File path.
   */
  _getBackupFilePath(flowId) {
    return path.join('/userdata', 'flow_backups', `backup_${flowId}.json`);
  }

  /**
   * Reads a flow backup.
   *
   * @private
   * @param {string} flowId - Flow ID.
   * @returns {Promise<Object|null>} Backup.
   */
  async _readBackup(flowId) {
    try {
      const data = await fs.promises.readFile(this._getBackupFilePath(flowId), 'utf8');
      return JSON.parse(data);
    } catch (err) {
      return null;
    }
  }

  /**
   * Writes backup if time window is respected.
   *
   * @private
   * @param {string} flowId - Flow ID.
   * @param {Object} flowObj - Flow object.
   * @param {string} type - Flow type.
   * @returns {Promise<void>}
   */
  async _writeBackup(flowId, flowObj, type) {
    try {
      const backupDir = path.join('/userdata', 'flow_backups');
      await fs.promises.mkdir(backupDir, { recursive: true }).catch(() => {});
      const backupPath = this._getBackupFilePath(flowId);

      try {
        const stats = await fs.promises.stat(backupPath);
        const now = new Date().getTime();
        const mtime = stats.mtime.getTime();
        const hoursDiff = (now - mtime) / (1000 * 60 * 60);
        
        if (hoursDiff < BACKUP_PROTECTION_HOURS) {
          this.homey.log(`[FlowManager] [Backup] Skipping backup for flow ${flowId}: a recent backup already exists (created ${hoursDiff.toFixed(1)} hours ago).`);
          return;
        }
      } catch (err) {
        // File does not exist
      }

      const backup = { type, backedUpAt: new Date().toISOString(), flow: flowObj };
      await fs.promises.writeFile(backupPath, JSON.stringify(backup, null, 2), 'utf8');
      this.homey.log(`[FlowManager] [Backup] Saved backup for flow ${flowId} at ${backupPath}`);
    } catch (err) {
      this.homey.log(`[FlowManager] [Backup] Failed to write backup for flow ${flowId}:`, err.message);
    }
  }

  /**
   * Deletes a backup.
   *
   * @private
   * @param {string} flowId - ID.
   * @returns {Promise<void>}
   */
  async _deleteBackupFile(flowId) {
    try {
      await fs.promises.unlink(this._getBackupFilePath(flowId));
    } catch (err) {
      // ignore
    }
  }

  /**
   * Finds a backup by name.
   *
   * @private
   * @param {string} flowName - Name.
   * @returns {Promise<Object|null>} Backup match info.
   */
  async _findBackupByName(flowName) {
    try {
      const backupDir = path.join('/userdata', 'flow_backups');
      const files = await fs.promises.readdir(backupDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const data = await fs.promises.readFile(path.join(backupDir, file), 'utf8');
          const backup = JSON.parse(data);
          if (backup.flow && backup.flow.name && backup.flow.name.toLowerCase() === flowName.toLowerCase()) {
            const match = file.match(/backup_(.+)\.json/);
            const originalId = match ? match[1] : backup.flow.id;
            return { originalId, backup };
          }
        }
      }
    } catch (err) {
      // ignore
    }
    return null;
  }

  /**
   * Clean standard flow for model usage.
   *
   * @private
   * @param {Object} flow - Raw flow.
   * @returns {Object} Clean flow.
   */
  _cleanStandardFlow(flow) {
    return {
      id: flow.id,
      name: flow.name,
      enabled: flow.enabled !== false,
      trigger: flow.trigger ? {
        id: flow.trigger.id,
        args: flow.trigger.args || {}
      } : null,
      conditions: Array.isArray(flow.conditions)
        ? flow.conditions.map(c => ({
            id: c.id,
            args: c.args || {},
            group: c.group || null,
            inverted: c.inverted !== false
          }))
        : [],
      actions: Array.isArray(flow.actions)
        ? flow.actions.map(a => ({
            id: a.id,
            args: a.args || {},
            group: a.group || 'then',
            delay: a.delay || null,
            duration: a.duration || null
          }))
        : []
    };
  }

  /**
   * Clean advanced flow for model usage.
   *
   * @private
   * @param {Object} flow - Raw advanced flow.
   * @returns {Object} Clean flow.
   */
  _cleanAdvancedFlow(flow) {
    const cards = {};

    if (flow.cards && typeof flow.cards === 'object') {
      Object.entries(flow.cards).forEach(([key, card]) => {
        cards[key] = {
          type: card.type || null,
          id: card.id || null,
          args: card.args || {},
          ...(card.delay ? { delay: card.delay } : {}),
          ...(card.duration ? { duration: card.duration } : {})
        };
      });
    }

    return {
      id: flow.id,
      name: flow.name,
      enabled: flow.enabled !== false,
      cards
    };
  }
}

module.exports = { FlowManager };
