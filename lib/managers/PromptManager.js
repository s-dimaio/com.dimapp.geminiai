'use strict';

/**
 * Settings key used for storing the array of saved prompts.
 * @constant {string}
 */
const SETTINGS_KEY_SAVED_PROMPTS = 'gemini_saved_prompts';

/**
 * Manages the persistent library of saved prompts for the Gemini AI app.
 *
 * Provides CRUD operations, title-based search, autocomplete formatting for
 * Homey Flow cards, and strict mutual exclusion resolution between saved
 * and manual prompt inputs.
 */
class PromptManager {

  /**
   * Initializes a new instance of PromptManager.
   *
   * @public
   * @constructor
   * @param {import('homey')} homey - The Homey application instance.
   * @example
   * const promptManager = new PromptManager(this.homey);
   */
  constructor(homey) {
    this.homey = homey;
  }

  /**
   * Retrieves all raw prompt records from Homey persistent settings.
   *
   * @private
   * @returns {Array<object>} Array of prompt objects stored in settings.
   */
  _getStoredPrompts() {
    try {
      const data = this.homey.settings.get(SETTINGS_KEY_SAVED_PROMPTS);
      if (Array.isArray(data)) {
        return data;
      }
      return [];
    } catch (err) {
      if (this.homey?.error) {
        this.homey.error('[PromptManager:_getStoredPrompts] Error reading settings:', err.message || err);
      }
      return [];
    }
  }

  /**
   * Persists an array of prompt records into Homey settings.
   *
   * @private
   * @param {Array<object>} prompts - Array of prompt objects to persist.
   * @returns {void}
   */
  _setStoredPrompts(prompts) {
    try {
      this.homey.settings.set(SETTINGS_KEY_SAVED_PROMPTS, prompts);
    } catch (err) {
      if (this.homey?.error) {
        this.homey.error('[PromptManager:_setStoredPrompts] Error writing settings:', err.message || err);
      }
      throw err;
    }
  }

  /**
   * Generates a unique identifier string for a new prompt record.
   *
   * @private
   * @returns {string} Unique prompt identifier.
   */
  _generateId() {
    return `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  /**
   * Retrieves all saved prompts, sorted alphabetically by title.
   * Optionally filters records by a case-insensitive search term on the title.
   *
   * @public
   * @param {object} [options={}] - Search and filter options.
   * @param {string} [options.search] - Optional case-insensitive search substring for title.
   * @returns {Array<object>} Array of prompt objects.
   * @example
   * const prompts = promptManager.getAllPrompts({ search: 'tv' });
   */
  getAllPrompts(options = {}) {
    let prompts = this._getStoredPrompts();

    const searchTerm = typeof options.search === 'string' ? options.search.trim().toLowerCase() : '';
    if (searchTerm.length > 0) {
      prompts = prompts.filter(p => p.title && p.title.toLowerCase().includes(searchTerm));
    }

    return prompts.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  }

  /**
   * Retrieves a single saved prompt by its unique identifier.
   *
   * @public
   * @param {string} id - The prompt unique identifier.
   * @returns {?object} The prompt object if found, otherwise null.
   * @example
   * const prompt = promptManager.getPromptById('prompt_1792350000000_a1b2c');
   */
  getPromptById(id) {
    if (!id || typeof id !== 'string') {
      return null;
    }
    const prompts = this._getStoredPrompts();
    return prompts.find(p => p.id === id) || null;
  }

  /**
   * Creates a new prompt or updates an existing prompt record.
   * Validates mandatory fields (title and content) and normalizes timestamps.
   *
   * @public
   * @param {object} data - Prompt data to persist.
   * @param {string} [data.id] - Existing prompt ID if updating, or omit for a new record.
   * @param {string} data.title - The prompt title (mandatory).
   * @param {string} [data.description] - Optional short description.
   * @param {string} data.content - The Markdown prompt content (mandatory).
   * @returns {object} The saved prompt record.
   * @throws {Error} If title or content are empty or invalid.
   * @example
   * const saved = promptManager.savePrompt({
   *   title: 'Bedtime Check',
   *   description: 'Checks all downstairs lights and locks',
   *   content: 'Check whether all doors are locked and turn off ground floor lights.'
   * });
   */
  savePrompt(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Prompt data object is required');
    }

    const title = typeof data.title === 'string' ? data.title.trim() : '';
    if (!title) {
      throw new Error(this.homey.__('settings.prompt_library.error_title_required') || 'Prompt title is required');
    }

    const content = typeof data.content === 'string' ? data.content.trim() : '';
    if (!content) {
      throw new Error(this.homey.__('settings.prompt_library.error_content_required') || 'Prompt content is required');
    }

    const description = typeof data.description === 'string' ? data.description.trim() : '';
    const prompts = this._getStoredPrompts();
    const now = new Date().toISOString();

    let targetPrompt;
    if (data.id) {
      const existingIndex = prompts.findIndex(p => p.id === data.id);
      if (existingIndex !== -1) {
        targetPrompt = {
          ...prompts[existingIndex],
          title,
          description,
          content,
          updatedAt: now
        };
        prompts[existingIndex] = targetPrompt;
      }
    }

    if (!targetPrompt) {
      targetPrompt = {
        id: this._generateId(),
        title,
        description,
        content,
        createdAt: now,
        updatedAt: now
      };
      prompts.push(targetPrompt);
    }

    this._setStoredPrompts(prompts);
    return targetPrompt;
  }

  /**
   * Deletes a prompt record by its unique identifier.
   *
   * @public
   * @param {string} id - The prompt unique identifier.
   * @returns {boolean} True if a prompt was removed, false otherwise.
   * @example
   * const deleted = promptManager.deletePrompt('prompt_1792350000000_a1b2c');
   */
  deletePrompt(id) {
    if (!id || typeof id !== 'string') {
      return false;
    }
    const prompts = this._getStoredPrompts();
    const initialLength = prompts.length;
    const filtered = prompts.filter(p => p.id !== id);

    if (filtered.length !== initialLength) {
      this._setStoredPrompts(filtered);
      return true;
    }
    return false;
  }

  /**
   * Duplicates an existing prompt record, generating a fresh ID and
   * appending a localized copy suffix to the title.
   *
   * @public
   * @param {string} id - The unique identifier of the prompt to duplicate.
   * @returns {object} The duplicated prompt record.
   * @throws {Error} If the source prompt is not found.
   * @example
   * const copy = promptManager.duplicatePrompt('prompt_1792350000000_a1b2c');
   */
  duplicatePrompt(id) {
    const source = this.getPromptById(id);
    if (!source) {
      throw new Error(this.homey.__('settings.prompt_library.error_not_found') || 'Source prompt not found');
    }

    const copySuffix = this.homey.__('settings.prompt_library.copy_suffix') || '(Copy)';
    const duplicatedTitle = `${source.title} ${copySuffix}`.trim();

    return this.savePrompt({
      title: duplicatedTitle,
      description: source.description || '',
      content: source.content || ''
    });
  }

  /**
   * Produces an autocomplete options list for Homey Flow card argument pickers.
   * Filters prompts matching the query against their title.
   *
   * @public
   * @param {string} [query=''] - Search substring typed by the user in the Flow card.
   * @returns {Array<{id: string, name: string, description: string}>} Autocomplete results.
   * @example
   * card.registerArgumentAutocompleteListener('saved_prompt', (query) => {
   *   return promptManager.getAutocompleteOptions(query);
   * });
   */
  getAutocompleteOptions(query = '') {
    const rawQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const prompts = this.getAllPrompts();

    const filtered = rawQuery.length > 0
      ? prompts.filter(p => (p.title && p.title.toLowerCase().includes(rawQuery)))
      : prompts;

    return filtered.map(p => {
      let preview = p.description || '';
      if (!preview && p.content) {
        preview = p.content.replace(/\s+/g, ' ').trim();
        if (preview.length > 60) {
          preview = preview.slice(0, 57) + '...';
        }
      }
      return {
        id: p.id,
        name: p.title,
        description: preview
      };
    });
  }

  /**
   * Resolves the effective prompt text for a Flow card execution with mutual exclusion validation.
   *
   * Enforces that exactly one of the two inputs is supplied:
   * 1. If BOTH saved_prompt AND manual prompt are provided, throws localized error.
   * 2. If NEITHER saved_prompt NOR manual prompt is provided, throws localized error.
   * 3. If saved_prompt is provided, loads the prompt dynamically from settings by ID (so updates
   *    in settings take effect immediately across all Flows). If deleted, throws localized error.
   * 4. If manual prompt is provided, returns its trimmed text.
   *
   * @public
   * @param {object} args - The arguments passed by Homey to the Flow card run listener.
   * @param {string} [manualFieldName='prompt'] - Name of the manual text argument ('prompt' or 'command').
   * @returns {string} The resolved prompt text to send to Gemini.
   * @throws {Error} If validation fails or the referenced saved prompt is missing.
   * @example
   * const prompt = promptManager.resolveFlowPrompt(args, 'command');
   */
  resolveFlowPrompt(args, manualFieldName = 'prompt') {
    if (!args || typeof args !== 'object') {
      throw new Error(this.homey.__('prompt.error.empty_prompt') || 'No prompt arguments provided');
    }

    const savedArg = args.saved_prompt;
    const manualArg = args[manualFieldName];

    const hasSaved = Boolean(
      savedArg &&
      typeof savedArg === 'object' &&
      typeof savedArg.id === 'string' &&
      savedArg.id.trim().length > 0
    );

    const hasManual = Boolean(
      typeof manualArg === 'string' &&
      manualArg.trim().length > 0
    );

    // Mutual exclusion: both provided is forbidden
    if (hasSaved && hasManual) {
      throw new Error(
        this.homey.__('prompt.error.both_prompts_provided') ||
        'Cannot provide both a saved prompt and a manual prompt. Please populate only one field.'
      );
    }

    // Mutual exclusion: neither provided is forbidden
    if (!hasSaved && !hasManual) {
      throw new Error(
        this.homey.__('prompt.error.empty_prompt') ||
        'Please select a saved prompt from the library or type a manual prompt.'
      );
    }

    // Resolve saved prompt dynamically from settings
    if (hasSaved) {
      const savedPrompt = this.getPromptById(savedArg.id);
      if (!savedPrompt || !savedPrompt.content) {
        throw new Error(
          this.homey.__('prompt.error.saved_prompt_not_found') ||
          'The selected saved prompt could not be found in the Prompt Library.'
        );
      }
      return savedPrompt.content.trim();
    }

    // Resolve manual prompt
    return manualArg.trim();
  }
}

module.exports = { PromptManager };
