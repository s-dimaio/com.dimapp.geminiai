'use strict';

const { Type } = require('@google/genai');

/**
 * Returns the complete list of MCP tool definitions in Gemini function-calling format.
 *
 * This module is intentionally a pure function with no side effects and no dependencies
 * on {@link HomeyMCPAdapter} or any Homey runtime objects. Keeping tool schemas decoupled
 * from the adapter logic makes them easier to maintain, review, and unit test independently.
 *
 * * Each tool definition includes:
 * - A `name` field used by Gemini to invoke the tool.
 * - A rich Markdown `description` that guides the model on when and how to use the tool.
 * - An `inputSchema` that formally constrains the types and shapes of each parameter,
 *   including nested JSON schemas where appropriate, to reduce hallucinated argument formats.
 *
 * Note: The `GeminiClient` dynamically injects a `gemini_model` parameter schema
 * into every tool's properties at runtime. This dynamic parameter contains the enum
 * values and descriptions configured in the user's settings, ensuring model selection
 * remains fully dynamic and synchronized with the app configurations.
 *
 * @public
 * @returns {Array<{name: string, description: string, inputSchema: object}>}
 *   Array of MCP tool definition objects ready to be passed to the Gemini API `tools` config.
 * @example
 * const { getTools } = require('./ToolSchema');
 * const tools = getTools();
 * // tools[0].name === 'control_device'
 */
function getTools() {
    return [
        {
            name: 'control_device',
            description: `
                Control a Homey device by changing a capability value.

                **Use this to:**
                - Turn devices on/off
                - Adjust brightness
                - Set temperature
                - Change volume

                **Examples:**
                - Turn light on: \`capability='onoff'\`, \`value=true\`
                - Dim to 50%: \`capability='dim'\`, \`value=0.5\`
                - Set thermostat to 21°C: \`capability='target_temperature'\`, \`value=21\`

                **IMPORTANT:** You must **ALWAYS** use the exact device name and the correct capability name.
                **Fallback:** If the specific command is not available here (e.g. "reset", "start program"), check \`discover_flow_cards\`.`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    deviceName: {
                        type: Type.STRING,
                        description: "Exact device name. This must **ALWAYS** be provided in all requests. Gemini infers this from user queries or discovers it via discover_resources."
                    },
                    deviceId: {
                        type: Type.STRING,
                        description: "Device UUID. Use ONLY as a fallback if this tool previously returned ambiguous=true, obtaining the ID from the matches array. Do not guess UUIDs."
                    },
                    capability: {
                        type: Type.STRING,
                        description: "Capability to control. Common values: 'onoff' (true/false for on/off), 'dim' (0.0-1.0 for brightness), 'target_temperature' (number in degrees), 'volume_set' (0.0-1.0 for volume), 'windowcoverings_state' ('up'/'idle'/'down'). Check device state first to see available capabilities."
                    },
                    value: {
                        description: "Value to set. You must **ALWAYS** pass a native JSON primitive matching the capability type — **❌ NEVER** pass a stringified value. Type depends on capability: boolean (true=on, false=off) for 'onoff'; number 0.0–1.0 for 'dim' or 'volume_set'; number in °C for 'target_temperature'; string ('up'/'idle'/'down') for 'windowcoverings_state'; string for 'thermostat_mode' or other enum-based capabilities."
                    }
                },
                required: ['deviceName', 'capability', 'value']
            }
        },
        {
            name: 'trigger_flow',
            description: `
                Trigger/execute a Homey Flow (automation).

                **Use this to activate:**
                - Scenes (e.g., 'Good Morning', 'Movie Time')
                - Complex automations (e.g., 'Away Mode')

                **Requirements:**
                - Flow must exist in Homey
                - Flow must be enabled
                - You need the **exact flow name**`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    flowName: {
                        type: Type.STRING,
                        description: "Exact name of the Flow to trigger (e.g., 'Good Morning', 'Evening Lights', 'Away Mode'). The Flow name must **ALWAYS** match exactly as defined in Homey."
                    },
                    args: {
                        type: Type.OBJECT,
                        description: "Optional arguments/tokens to pass to the flow (for Advanced Flows with arguments). Key-value pairs."
                    }
                },
                required: ['flowName']
            }
        },
        {
            name: 'get_device_state',
            description: `
                 **REQUIRED** to check the current state of any Homey device.

                 **Use this for:**
                 - Check if light is on/off
                 - Read current temperature
                 - Query any device capability value

                 **Response includes:**
                 - \`available\`: whether the device is reachable.
                 - \`unavailableMessage\`: (only when \`available=false\`) the error message provided by Homey explaining why the device is offline (e.g., authentication error, connection lost). Use this to give the user a precise explanation.

                 **IMPORTANT:** This is your ONLY way to read device states.`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    deviceName: {
                        type: Type.STRING,
                        description: "Name of the device to query. This must **ALWAYS** be provided in all requests."
                    },
                    deviceId: {
                        type: Type.STRING,
                        description: "Device UUID. Use ONLY as a fallback if this tool previously returned ambiguous=true. Do not guess UUIDs."
                    }
                },
                required: ['deviceName']
            }
        },
        {
            name: 'discover_flows',
            description: `
                Discover, list, and get information about Homey Flows (automations).

                **Use this when:**
                - User asks "what flows do I have?", "list my automations"
                - You need to find a flow name before calling \`trigger_flow\`
                - User asks about a specific flow ("what does X flow do?")

                **Flow Types:**
                - **Standard Flow**: Traditional when-and-then flows
                - **Advanced Flow**: Visual canvas-based flows (Homey Pro only)

                **Filters available (optional):**
                - \`flowName\`: Exact or partial name to get details about a specific flow
                - \`enabled\`: true (only active flows), false (only disabled flows)
                - \`folder\`: folder name to filter by specific folder
                - \`type\`: 'standard', 'advanced', or 'all'

                **Returns:**
                - If \`flowName\` is provided, returns flow details (or suggests similar names if not found)
                - Otherwise, returns a list of flows matching the filters with summary counts`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    flowName: {
                        type: Type.STRING,
                        description: "Optional. Exact or partial name of a specific flow to get information about."
                    },
                    enabled: {
                        type: Type.BOOLEAN,
                        description: 'Optional filter: true for enabled flows only, false for disabled flows only. Omit to show all flows.'
                    },
                    folder: {
                        type: Type.STRING,
                        description: 'Optional filter: folder name to show only flows in that folder.'
                    },
                    type: {
                        type: Type.STRING,
                        description: "Optional filter: 'standard' for standard flows, 'advanced' for Advanced Flows, 'all' for both.",
                        enum: ['standard', 'advanced', 'all']
                    }
                },
                required: []
            }
        },
        {
            name: 'discover_resources',
            description: `
                 Discover devices, user-installed apps, or built-in system managers in Homey.

                 **Returns MINIMAL info only:** name, id, class, zone, available (for devices) or ownerUri (for apps/managers).
                 - If a device is unavailable, the \`unavailableMessage\` field may be present with the Homey error reason.
                 **To get capabilities and available actions:** call \`get_device_state(deviceName)\` and \`discover_flow_cards(deviceName)\`.

                **Use this when:**
                - User asks to list or search devices, apps, or system integrations.
                - You need to find devices in a specific room (use \`zoneName\`) or of a specific type (use \`deviceClass\`).
                - You need to search for a resource by keyword or name (use \`query\`).
                - You need to find the ownerUri of an app or manager before discovering its flow cards (use \`type='app'\` or \`type='system'\`).

                **Available classes:** \`light\`, \`socket\`, \`thermostat\`, \`lock\`, \`sensor\`, \`speaker\`, \`tv\`, \`fan\`, \`heater\`, \`camera\`, \`doorbell\`, \`blinds\`, \`curtain\`, \`sunshade\`, etc.

                ### IMPORTANT: Overriding hidden/grouped device visibility
                The \`includeHiddenGrouped\` parameter lets you override the global app setting for this specific call:
                - **\`true\`**: **ALWAYS** include hidden and grouped devices, regardless of the global setting.
                - **\`false\`**: **❌ NEVER** include hidden and grouped devices, regardless of the global setting.
                - **Omitted** (default): defer to the app's global setting configured by the user.

                **❌ NEVER** set this parameter unless the user has explicitly asked to include or exclude hidden/grouped devices in this specific request.`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    zoneName: {
                        type: Type.STRING,
                        description: "Optional. Zone/room name to filter by (e.g., 'Living Room'). Case-insensitive. Searches recursively including sub-zones."
                    },
                    deviceClass: {
                        type: Type.STRING,
                        description: "Optional. Device class to filter by (e.g. 'light', 'socket', 'thermostat')."
                    },
                    type: {
                        type: Type.STRING,
                        description: "Optional. Omit or use 'device' for physical devices (default). Use 'app' to list user-installed apps with ownerUri. Use 'system' to list built-in system managers with ownerUri.",
                        enum: ['device', 'app', 'system']
                    },
                    query: {
                        type: Type.STRING,
                        description: "Optional search query. Search across device names and tags. Supports comma-separated keywords for fuzzy matching across multiple languages (e.g. 'luce, light, cucina, kitchen, lumière, cuisine'). Use as many language variants and synonyms as needed to maximise the chance of a match."
                    },
                    includeHiddenGrouped: {
                        type: Type.BOOLEAN,
                        description: "Optional override for hidden/grouped device visibility. true: force-include hidden and grouped devices regardless of the global app setting. false: force-exclude them regardless of the global setting. Omit entirely to defer to the global app setting. **❌ NEVER** set this unless the user has explicitly asked to include or exclude hidden/grouped devices in this specific request."
                    }
                },
                required: []
            }
        },
        {
            name: 'get_home_summary',
            description: `
                Get status and count summary of devices, optionally filtered by class or zone.

                **Use this for counting and status queries:**
                - "which lights are on?", "what's the lock status?"
                - "How many lights in the bedroom?"
                - "What's on in the kitchen?" (with \`zone='Kitchen'\`)
                - "Are there lights on in the studio?" (with \`zone='Studio'\` and \`deviceClass='light'\`)
                - "What sockets are on?" (no zone parameter, \`deviceClass='socket'\`)
                - Searches recursively (includes sub-zones)
                - No parameters: returns a global count summary grouped by class

                **Response Format:**
                - Returns: \`summary\` (total, on, off counts) AND \`devices\` (array with complete state)
                - Each device includes complete \`state\` object with all capability values
                 - Returns: \`unavailableDevices\` (array of \`{ name, zone, class, unavailableMessage? }\` objects). Use this field to instantly check if any device is offline or has connection issues in the home (or in the queried zone) with very low token overhead. The optional \`unavailableMessage\` field, when present, contains the exact error reason provided by Homey (e.g., \"Authentication error\", \"Connection lost\").
                
                **Specific States:**
                - **Locks**: Check \`state.locked\` (true=locked, false=unlocked)
                - **Sensors**: Check \`state.alarm_motion\`, \`state.alarm_contact\`, etc.
                - **Thermostats**: Check \`state.target_temperature\`, \`state.measure_temperature\`
                - **Window Coverings**: Check \`state.windowcoverings_state\`

                ### IMPORTANT: Overriding hidden/grouped device visibility
                The \`includeHiddenGrouped\` parameter lets you override the global app setting for this specific call:
                - **\`true\`**: **ALWAYS** include hidden and grouped devices, regardless of the global setting.
                - **\`false\`**: **❌ NEVER** include hidden and grouped devices, regardless of the global setting.
                - **Omitted** (default): defer to the app's global setting configured by the user.

                **❌ NEVER** set this parameter unless the user has explicitly asked to include or exclude hidden/grouped devices in this specific request.`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    deviceClass: {
                        type: Type.STRING,
                        description: "Optional. Device class to query. Common values: 'light', 'socket', 'thermostat', 'fan', 'switch', 'camera', 'lock', 'speaker', 'sensor', 'airconditioning', 'heater'."
                    },
                    zone: {
                        type: Type.STRING,
                        description: "Optional. Zone/room name to filter results (e.g., 'Kitchen', 'Bedroom', 'Studio'). If omitted, returns devices from all zones."
                    },
                    includeHiddenGrouped: {
                        type: Type.BOOLEAN,
                        description: "Optional override for hidden/grouped device visibility. true: force-include hidden and grouped devices regardless of the global app setting. false: force-exclude them regardless of the global setting. Omit entirely to defer to the global app setting. **❌ NEVER** set this unless the user has explicitly asked to include or exclude hidden/grouped devices in this specific request."
                    }
                },
                required: []
            }
        },

        {
            name: 'manage_schedule',
            description: `
                Manage scheduled commands (create a new scheduled action, list pending actions, or cancel an action).

                **Actions available:**
                - \`create\`: Schedule a command to execute at a future time (requires \`command\`, \`executeAt\`, \`description\`).
                - \`list\`: List all currently pending scheduled commands, returning their IDs and descriptions.
                - \`cancel\`: Cancel a scheduled command using its unique schedule ID.

                **Workflow example:**
                1. User: "Annula il comando per spegnere la luce"
                2. Call \`manage_schedule({action: 'list'})\` → find the scheduleId representing "spegnere la luce"
                3. Call \`manage_schedule({action: 'cancel', scheduleId: '...'})\` to cancel it.`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    action: {
                        type: Type.STRING,
                        description: "The action to perform: 'create' (to schedule a command), 'list' (to show pending commands), or 'cancel' (to cancel a scheduled command).",
                        enum: ['create', 'list', 'cancel']
                    },
                    command: {
                        type: Type.STRING,
                        description: "Required for 'create': The natural language command to execute. It must **❌ NEVER** contain time references (e.g. 'turn off lights')."
                    },
                    executeAt: {
                        type: Type.STRING,
                        description: "Required for 'create': ISO 8601 local datetime, format: 'YYYY-MM-DDTHH:MM:SS' (Homey timezone). Do not append UTC timezone suffixes. Conversion to UTC is handled automatically."
                    },
                    description: {
                        type: Type.STRING,
                        description: "Required for 'create': A short summary of the exact action to be performed (e.g., 'Turn off living room lights')."
                    },
                    scheduleId: {
                        type: Type.STRING,
                        description: "Required for 'cancel': The unique schedule ID of the command to cancel (retrieve this by calling action='list' first)."
                    }
                },
                required: ['action']
            }
        },
        {
            name: 'discover_flow_cards',
            description: `
                List Flow Cards (action, trigger, or condition) available for a specific device, app, or system manager.

                **Use this when:**
                - You need to find action card IDs to use with \`run_action_card\` (cardType='action', default)
                - You are building a flow and need the trigger card ID (cardType='trigger')
                - You are building a flow and need a condition card ID (cardType='condition')
                - User asks "what can I do with [device]?"

                **IMPORTANT — Token protection:**
                - For \`cardType='action'\`: \`deviceName\` is required.
                - For \`cardType='trigger'\` or \`'condition'\`: you must **ALWAYS** provide either \`deviceName\` (for device-based cards) OR \`ownerUri\` (for app/system manager cards). Obtain \`ownerUri\` via \`discover_resources(type='app'|'system')\`.
                - If neither filter is provided for trigger/condition, the tool will return an error.

                **Returns:**
                - List of cards with \`id\`, \`title\`, \`args\` (arguments required to configure the card)
                - For action cards: also includes \`tokens\` (output tokens the card produces)`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    cardType: {
                        type: Type.STRING,
                        description: "Type of flow card to discover. 'action' (default): action cards for a device, used with run_action_card, manage_flow or manage_advanced_flow. 'trigger': trigger cards for a device, app or system manager — use before manage_flow or manage_advanced_flow to find the trigger. 'condition': condition cards — use before manage_flow or manage_advanced_flow to find conditions.",
                        enum: ['action', 'trigger', 'condition']
                    },
                    deviceName: {
                        type: Type.STRING,
                        description: "Name of the device to list cards for. Required for cardType='action'. Optional for 'trigger'/'condition' if ownerUri is provided instead."
                    },
                    deviceId: {
                        type: Type.STRING,
                        description: "Device UUID. Use ONLY as a fallback if this tool previously returned ambiguous=true. Do not guess UUIDs."
                    },
                    ownerUri: {
                        type: Type.STRING,
                        description: "Filter trigger/condition cards by their owner's URI (e.g. 'homey:app:com.athom.homeyscript', 'homey:manager:clock'). Obtain this value from discover_resources(type='app') or discover_resources(type='system'). Use instead of deviceName for non-device triggers."
                    }
                },
                required: []
            }
        },
        {
            name: 'run_action_card',
            description: `
                Execute a specific Action Card on a device.
                
                **Use this when:**
                - You want to execute a specific action found via \`discover_flow_cards\`
                - User requests a device-specific command (e.g. "Reset energy meter on Socket A", "Take camera snapshot")

                **Returns:**
                - Success confirmation
                - **Image tokens**: If the action card produces an image (e.g., camera snapshot), the image will be automatically included for visual analysis
                - **Other tokens**: Text/number/boolean tokens returned by the action card (if any)

                **Requirements:**
                - You must **ALWAYS** have the \`cardId\` (from \`discover_flow_cards\`)
                - You must **ALWAYS** provide any required arguments map`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    deviceName: {
                        type: Type.STRING,
                        description: 'Name of the device. This must **ALWAYS** be provided in all requests.'
                    },
                    deviceId: {
                        type: Type.STRING,
                        description: "Device UUID. Use ONLY as a fallback if this tool previously returned ambiguous=true. Do not guess UUIDs."
                    },
                    cardId: {
                        type: Type.STRING,
                        description: 'The unique ID of the action card to execute (get this from discover_flow_cards)'
                    },
                    args: {
                        type: Type.OBJECT,
                        description: "Map of arguments required by the card. Empty object if no args."
                    }
                },
                required: ['deviceName', 'cardId']
            }
        },
        {
            name: 'get_device_image',
            description: `
                Get the current image/snapshot from a device (camera, doorbell, webcam, etc.).

                **Use this when:**
                - User wants to see what a camera is showing **without** triggering a new snapshot
                - You need to analyze the current state of a camera device
                - User asks "what does the camera see?" or "show me the doorbell feed"

                **Returns:**
                - The current device image for visual analysis
                - Image will be automatically analyzed by the AI

                **Important:**
                - This retrieves the **existing** image from the device
                - To capture a **new** snapshot, use \`run_action_card\` with the snapshot action card instead`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    deviceName: {
                        type: Type.STRING,
                        description: 'Name of the device. This must **ALWAYS** be provided in all requests.'
                    },
                    deviceId: {
                        type: Type.STRING,
                        description: "Device UUID. Use ONLY as a fallback if this tool previously returned ambiguous=true. Do not guess UUIDs."
                    }
                },
                required: ['deviceName']
            }
        },
        {
            name: 'get_device_logs',
            description: `
                Get historical data, logs, and trends for a specific device.
                
                **Use this when:**
                - User asks about past values (e.g., "what was the temperature yesterday?")
                - User wants to see trends, patterns, averages, or stats
                - User asks about energy consumption over time
                
                **Workflow:**
                - If you only pass \`deviceName\` without \`logId\`, you will get a list of available logs.
                - If you pass \`deviceName\` AND \`logId\` AND \`resolution\`, you will get the actual time-series data.
                
                **Resolution options (when fetching data):**
                - \`last24Hours\` - Hourly data for the last 24 hours
                - \`last7Days\` - Daily data for the last 7 days  
                - \`last14Days\` - Daily data for the last 14 days
                - \`last31Days\` - Daily data for the last 31 days
                - \`last6Months\` - Weekly data for the last 6 months
                - \`last1Years\` - Monthly data for the last year
                - \`last5Years\` - Yearly data for the last 5 years
                
                **Returns:**
                - Available logs metadata (if only deviceName passed)
                - Array of data points with local timestamp and value + stats (if all params passed)`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    deviceName: {
                        type: Type.STRING,
                        description: "Exact name of the device. This must **ALWAYS** be provided in all requests."
                    },
                    deviceId: {
                        type: Type.STRING,
                        description: "Device UUID. Use ONLY as a fallback if this tool previously returned ambiguous=true. Do not guess UUIDs."
                    },
                    logId: {
                        type: Type.STRING,
                        description: 'Optional. ID of the log to retrieve. If omitted, returns list of available logs.'
                    },
                    resolution: {
                        type: Type.STRING,
                        description: "Optional. Time resolution for the data. This must **ALWAYS** be provided if logId is provided.",
                        enum: ['last24Hours', 'last7Days', 'last14Days', 'last31Days', 'last6Months', 'last1Years', 'last5Years']
                    }
                },
                required: ['deviceName']
            }
        },
        {
            name: 'manage_flow',
            description: `
                Create, update, delete, or restore a Standard Homey Flow.

                **IMPORTANT:** This tool works on Standard Flows ONLY. Advanced Flows cannot be managed via this tool.

                **Use this when:**
                - User asks to create a new automation flow
                - User asks to modify an existing flow (rename, change trigger/conditions/actions)
                - User asks to delete an existing flow
                - User asks to undo a previous modification or restore a deleted flow (use \`action='restore'\` with \`flowId\` or \`flowName\`).

                **Workflow BEFORE calling manage_flow(action='create'):**

                For DEVICE triggers (e.g. 'when motion detected', 'when light turned on'):
                  1. discover_flow_cards(cardType='trigger', deviceName='...') → get trigger card id
                  2. (Optional) discover_flow_cards(cardType='condition', deviceName='...') → get condition card id
                  3. discover_flow_cards(cardType='action', deviceName='...') for each action device
                  4. manage_flow(action='create', ...)

                For APP triggers (e.g. 'when HomeyScript X runs'):
                  1. discover_resources(type='app') → get app ownerUri
                  2. discover_flow_cards(cardType='trigger', ownerUri='...') → get trigger card id
                  3. discover_flow_cards(cardType='action', deviceName='...') for each action
                  4. manage_flow(action='create', ...)

                For SYSTEM triggers (e.g. 'every day at 8am', 'when I arrive home', 'at sunrise'):
                  1. discover_resources(type='system') → get system manager ownerUri
                  2. discover_flow_cards(cardType='trigger', ownerUri='...') → get trigger card id
                  3. discover_flow_cards(cardType='action', deviceName='...') for each action
                  4. manage_flow(action='create', ...)

                **Flow object format:**
                - \`trigger\`: { id: cardId, args: {} }  — NO \`uri\` field
                - \`conditions\`: array of { id, args, group, inverted? } — can be empty [] — NO \`uri\` field. \`group\` is MANDATORY (typically 'group1') to ensure the UI renders the conditions properly.
                - \`actions\`: array of { id, args, group: 'then', delay, duration: null } — This must **ALWAYS** have at least one item — It must **❌ NEVER** include a \`uri\` field
                  - \`delay\` should be null OR an object if a delay is requested: { enabled: true, number: "10", multiplier: 1 } (multiplier: 1=sec, 60=min. Convert hours to minutes).`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    action: {
                        type: Type.STRING,
                        description: "Operation to perform: 'create' (new flow), 'update' (modify existing flow), 'delete' (remove existing flow), 'restore' (restore previous state before last update/delete).",
                        enum: ['create', 'update', 'delete', 'restore']
                    },
                    name: {
                        type: Type.STRING,
                        description: "Name for the flow. Required for 'create'. Optional for 'update' (to rename)."
                    },
                    flowId: {
                        type: Type.STRING,
                        description: "Exact flow ID. Use for 'update' and 'delete' if known. Obtain from discover_flows."
                    },
                    flowName: {
                        type: Type.STRING,
                        description: "Exact flow name (case-insensitive). Used to look up the flow if flowId is not provided. Required for 'update'/'delete' if flowId is absent."
                    },
                    trigger: {
                        type: Type.OBJECT,
                        description: "Trigger card configuration. Required for 'create'. The 'id' is the full trigger card ID as returned by discover_flow_cards (e.g. 'homey:manager:cron:time_exactly'). Do NOT include a 'uri' field. When updating a flow and changing the trigger card, you must **ALWAYS** completely replace 'args' with ONLY the exact arguments accepted by the new trigger card schema. You must **❌ NEVER** carry over arguments from the previous trigger.",
                        properties: {
                            id: {
                                type: Type.STRING,
                                description: "Full trigger card ID as returned by discover_flow_cards (e.g. 'homey:manager:cron:time_exactly')."
                            },
                            args: {
                                type: Type.OBJECT,
                                description: "Trigger card arguments. You must **ALWAYS** pass a native JSON object matching the trigger card schema (e.g. {\"time\": \"08:00\"}). **❌ NEVER** stringify it, wrap it in quotes, or pass it as a JSON array."
                            }
                        },
                        required: ['id', 'args']
                    },
                    conditions: {
                        type: Type.ARRAY,
                        description: "Array of condition card configurations. Can be empty []. Do NOT include a 'uri' field. When replacing a condition card, you must **ALWAYS** discard its old 'args' and populate ONLY the arguments accepted by the new card schema.",
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                id: {
                                    type: Type.STRING,
                                    description: "Full condition card ID as returned by discover_flow_cards (e.g. 'homey:device:UUID:onoff'). Do NOT include a 'uri' field."
                                },
                                args: {
                                    type: Type.OBJECT,
                                    description: "Condition card arguments. You must **ALWAYS** pass a native JSON object matching the condition card schema. **❌ NEVER** stringify it or pass it as a JSON array."
                                },
                                group: {
                                    type: Type.STRING,
                                    description: "MANDATORY group identifier (typically 'group1'). You must **ALWAYS** specify this to prevent invisible/broken rendering in the Homey UI."
                                },
                                inverted: {
                                    type: Type.BOOLEAN,
                                    description: "Optional. Set to true to invert the condition logic (NOT condition). Omit if not needed."
                                }
                            },
                            required: ['id', 'args', 'group']
                        }
                    },
                    actions: {
                        type: Type.ARRAY,
                        description: "Array of action card configurations. Must contain at least one item for 'create'. Do NOT include a 'uri' field. When replacing an action card, you must **ALWAYS** discard the old 'args' and populate ONLY the arguments accepted by the new card schema. You must **❌ NEVER** carry over parameters from the previous action card.",
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                id: {
                                    type: Type.STRING,
                                    description: "Full action card ID as returned by discover_flow_cards (e.g. 'homey:device:UUID:off'). Do NOT include a 'uri' field."
                                },
                                args: {
                                    type: Type.OBJECT,
                                    description: "Action card arguments. You must **ALWAYS** pass a native JSON object matching the action card schema. **❌ NEVER** stringify it or pass it as a JSON array."
                                },
                                group: {
                                    type: Type.STRING,
                                    description: "You must **ALWAYS** set this to exactly 'then' for Standard Flow actions."
                                },
                                delay: {
                                    type: Type.OBJECT,
                                    description: "Optional delay before executing the action. Set to null if no delay is needed. If the user specifies hours, convert them to minutes (e.g. 1.5 hours = 90 minutes). **❌ NEVER** use multiplier 3600 (hours) — only 1 (seconds) and 60 (minutes) are supported.",
                                    properties: {
                                        enabled: {
                                            type: Type.BOOLEAN,
                                            description: "Whether the delay is active. You must **ALWAYS** set to true when a delay is configured."
                                        },
                                        number: {
                                            type: Type.STRING,
                                            description: "Delay duration as a string representing a max 2-digit integer (e.g. '10', '90'). **❌ NEVER** pass a number — it must be a string."
                                        },
                                        multiplier: {
                                            type: Type.INTEGER,
                                            description: "Time unit multiplier. Use 1 for seconds, 60 for minutes. **❌ NEVER** use 3600 (hours)."
                                        }
                                    },
                                    required: ['enabled', 'number', 'multiplier']
                                },
                                duration: {
                                    description: "You must **ALWAYS** set this to null."
                                }
                            },
                            required: ['id', 'args', 'group']
                        }
                    },
                    enabled: {
                        type: Type.BOOLEAN,
                        description: "Optional. Whether the flow should be enabled. Defaults to true for 'create'. Use in 'update' to enable/disable."
                    }
                },
                required: ['action']
            }
        },
        {
            name: 'discover_flow_details',
            description: `
                Retrieve the complete internal structure of a specific Homey Flow (Standard or Advanced).

                **Use this when:**
                - You need to inspect the exact trigger, conditions, actions and their arguments of a Flow before modifying it.
                - A user asks "why is flow [Name] not working?" or "explain how flow [Name] works".
                - You want to verify what arguments (args) are currently set on action cards (e.g. detect a wrong command or message parameter).
                - You are about to call \`manage_flow(action='update')\` and need to inspect the current structure first to avoid breaking existing actions.

                **Important:** This tool provides READ-ONLY inspection. To modify a flow, use \`manage_flow\`.

                **Returns:**
                - For Standard Flows: full trigger, conditions[], actions[] with their card IDs and arguments.
                - For Advanced Flows: all card nodes with their types, IDs and arguments (layout/coordinate data is stripped to save tokens).`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    flowId: {
                        type: Type.STRING,
                        description: "Unique UUID of the Flow. Highly recommended if known. Obtain it from discover_flows."
                    },
                    flowName: {
                        type: Type.STRING,
                        description: "Exact name of the Flow (case-insensitive). Use as a fallback if flowId is not known."
                    }
                },
                required: []
            }
        },
        {
            name: 'manage_advanced_flow',
            description: `
                Create, update, delete, or restore an Advanced Homey Pro Flow (graph-based DAG canvas automation).

                **IMPORTANT:** Deletion and modification (update) of an Advanced Flow require explicit user confirmation. Do NOT invoke action='delete' or action='update' immediately without asking the user for natural-language confirmation first, stating exactly what you intend to delete/modify.

                **Use this when:**
                - Creating visual canvas-based automations where cards must execute in sequence.
                - Connecting multiple action cards together or using output tokens from one card in a subsequent card.
                - Deleting or updating an existing Advanced Flow.
                - Restoring a previously deleted or updated Advanced Flow (use \`action='restore'\` with \`flowId\` or \`flowName\`).

                **How coordinates (x, y) are handled:**
                - You must **❌ NEVER** specify \`x\` and \`y\` layout coordinates in any card object. The system automatically computes visual positions using a graph layout engine. Adding coordinates will break the auto-layout and produce an unbalanced canvas.

                **Strict Cards Dictionary Format:**
                The \`cards\` object must **ALWAYS** be a map where EVERY key is a UUID you generate (e.g. \`ae825c34-0f14-4d68-84a1-16c9d8bddbb2\`) or a unique key like \`card_start\`. The value of each key must **ALWAYS** be a complete Card Node object. You must **❌ NEVER** place card properties (\`id\`, \`type\`, \`args\`, \`ownerUri\`) directly at the root of \`cards\`.

                **Card Node structure:**
                - \`type\`: string, required. One of: \`'trigger'\`, \`'condition'\`, \`'action'\`, \`'any'\`, \`'all'\`, \`'start'\`, \`'delay'\`.
                - \`id\`: string. Required for \`trigger\`, \`condition\`, \`action\` types. Full card ID (e.g. \`'homey:device:<uuid>:onoff'\`).
                - \`ownerUri\`: string. Required for \`trigger\`, \`condition\`, \`action\` types (e.g. \`'homey:device:<uuid>'\`, \`'homey:app:com.dimapp.geminiai'\`).
                - \`args\`: object. You must **ALWAYS** pass a native JSON object (e.g. \`{ "time": "08:00" }\`). **❌ NEVER** stringify it, **❌ NEVER** pass it as a JSON array.
                  * For \`all\`, \`any\`, and \`start\` cards: omit \`args\` entirely or set to \`{}\`.
                  * For \`delay\` cards: you must **ALWAYS** provide a nested \`delay\` sub-object: \`"args": { "delay": { "number": "20", "multiplier": 1 } }\` where \`number\` is a string (max 2 digits, e.g. \`"20"\`) and \`multiplier\` is \`1\` (seconds) or \`60\` (minutes). **❌ NEVER** use \`3600\` (hours). **❌ NEVER** pass \`args: null\` or \`args: {}\` for a delay card.
                  * For all other card types: populate according to the exact schema returned by \`discover_flow_cards\`.
                - \`input\`: array of strings. ONLY for \`all\` cards. Maps each parent card's output using format \`"<parentUuid>::<outputName>"\` (e.g. \`["<uuid>::outputSuccess"]\`).
                - \`outputSuccess\`: optional array of string (UUID keys of cards to trigger on success).
                - \`outputError\`: optional array of string (UUID keys of cards to trigger on error).
                - \`outputTrue\`: optional array of string (UUID keys of cards to trigger if condition is true).
                - \`outputFalse\`: optional array of string (UUID keys of cards to trigger if condition is false).
                - \`droptoken\`: optional string (only for condition cards, filters by preceding card output, e.g. \`'action::<prevCardUuid>::success'\`).
                - \`duration\`: optional number (duration in seconds).

                **Token & Tag Syntax (injecting card outputs into args):**
                When a card must consume output generated by a preceding card, inject tokens into its \`args\` using:
                - Action card output: \`[[action::<cardUuid>::<tokenId>]]\` (e.g. \`[[action::cb45e7f2-d14f-4f3c-a639-85f62c952164::answer]]\`)
                - Trigger card output: \`[[trigger::<cardUuid>::<tokenId>]]\` (e.g. \`[[trigger::3498e468-d353-43a7-926a-22372c9f096d::body]]\`)
                - Card execution error: \`[[card::<cardUuid>::error]]\`
                - Global Logic variable: \`[[homey:manager:logic|<variableId>]]\``,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    action: {
                        type: Type.STRING,
                        description: "Operation to perform: 'create' (new advanced flow), 'update' (modify existing advanced flow), 'delete' (remove existing advanced flow), 'restore' (restore previous state before last update/delete).",
                        enum: ['create', 'update', 'delete', 'restore']
                    },
                    name: {
                        type: Type.STRING,
                        description: "Name for the advanced flow. Required for 'create'. Optional for 'update' (to rename)."
                    },
                    flowId: {
                        type: Type.STRING,
                        description: "Unique UUID of the Advanced Flow. Required for 'update' and 'delete' if known."
                    },
                    flowName: {
                        type: Type.STRING,
                        description: "Exact name of the Advanced Flow (case-insensitive). Used to look up the flow if flowId is not provided. Required for 'update'/'delete' if flowId is absent."
                    },
                    cards: {
                        type: Type.ARRAY,
                        description: "Array of card node objects. Required for 'create', optional for 'update'. For incremental updates, ONLY include the cards you wish to 'create', 'update', or 'delete' (specifying the 'action' property for each). Cards omitted from this array remain completely untouched.",
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                action: {
                                    type: Type.STRING,
                                    description: "Action to perform on this card: 'create' (add a new card), 'update' (modify an existing card's properties like args), 'delete' (remove this card). Defaults to fallback behavior if omitted.",
                                    enum: ['create', 'update', 'delete']
                                },
                                uuid: {
                                    type: Type.STRING,
                                    description: "A unique identifier for this card node (e.g. a UUID you generate, or a unique key like 'card_start'). MUST be unique within the flow."
                                },
                                type: {
                                    type: Type.STRING,
                                    description: "Type of the card node. One of: 'trigger', 'condition', 'action', 'any', 'all', 'start', 'delay'."
                                },
                                id: {
                                    type: Type.STRING,
                                    description: "Required for 'trigger', 'condition', 'action' types. The full card ID as returned by discover_flow_cards (e.g. 'homey:device:UUID:onoff')."
                                },
                                ownerUri: {
                                    type: Type.STRING,
                                    description: "Required for 'trigger', 'condition', 'action' types. The owner URI of the card (e.g. 'homey:device:UUID', 'homey:app:com.dimapp.geminiai')."
                                },
                                args: {
                                    type: Type.OBJECT,
                                    description: "Arguments required by the card. You must ALWAYS pass a native JSON object (e.g. { \"time\": \"08:00\" }). ❌ NEVER stringify it, ❌ NEVER pass it as an array. Omit or set to {} for 'start', 'any', 'all' cards. For 'delay' cards, must be { \"delay\": { \"number\": \"20\", \"multiplier\": 1 } }."
                                },
                                input: {
                                    type: Type.ARRAY,
                                    items: { type: Type.STRING },
                                    description: "Optional array of string connections. ONLY for 'all' cards. Format: '<parentUuid>::<outputName>' (e.g. ['<uuid>::outputSuccess'])."
                                },
                                outputSuccess: {
                                    type: Type.ARRAY,
                                    items: { type: Type.STRING },
                                    description: "**⚠️ CRITICAL**: Array of UUIDs of the next cards to trigger on success. You must **ALWAYS** provide this to link cards together, otherwise the flow will be broken/disconnected."
                                },
                                outputError: {
                                    type: Type.ARRAY,
                                    items: { type: Type.STRING },
                                    description: "Array of UUIDs of the next cards to trigger on error. Use to link error fallback cards."
                                },
                                outputTrue: {
                                    type: Type.ARRAY,
                                    items: { type: Type.STRING },
                                    description: "**⚠️ CRITICAL**: Array of UUIDs of cards to trigger if condition is true. You must **ALWAYS** provide this for condition cards to link them to the next steps."
                                },
                                outputFalse: {
                                    type: Type.ARRAY,
                                    items: { type: Type.STRING },
                                    description: "Array of UUIDs of cards to trigger if condition is false. Use to link the 'else' branch of condition cards."
                                },
                                droptoken: {
                                    type: Type.STRING,
                                    description: "Optional string (condition cards only) to filter by preceding card output (e.g., 'action::<prevCardUuid>::success')."
                                },
                                duration: {
                                    type: Type.NUMBER,
                                    description: "Optional duration in seconds."
                                }
                            },
                            required: ['uuid', 'type']
                        }
                    },
                    enabled: {
                        type: Type.BOOLEAN,
                        description: "Optional. Whether the flow should be enabled. Defaults to true for 'create'. Use in 'update' to enable/disable."
                    }
                },
                required: ['action']
            }
        },
        {
            name: 'manage_device_firmware',
            description: `
                Manage device firmware updates (checking for updates on all devices, installing on Matter devices).

                **Use this to:**
                - List all supported devices and check which ones have a firmware update available (using action='list').
                - Check if a specific device (Matter, Zigbee, Z-Wave, etc.) has an update available (using action='check').
                - Trigger the installation of a firmware update on a Matter device (using action='install').

                ### IMPORTANT: Target and Action Limits
                * Checking updates (action='list' or action='check') works for all devices (Matter, Zigbee, Z-Wave, etc.).
                * Installing updates (action='install') works **ONLY** for Matter devices.
                * **⚠️ CRITICAL**: You must **❌ NEVER** call action='install' for Zigbee, Z-Wave, or non-Matter devices. If the user asks to update a non-Matter device, explain that it must be done manually via the Homey Pro App/Web interface.
                * For 'check' and 'install' actions, you must **ALWAYS** identify the target using either \`deviceName\` or \`deviceId\`.
                * For the 'list' action, you must **❌ NEVER** provide deviceName or deviceId, as it performs a global scan of all supported devices.

                ### MANDATORY: Version Specification
                * When installing a firmware update on a Matter node, you must **ALWAYS** provide the \`softwareVersion\` (an integer, e.g. 17367055) that was reported by the check action.`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    action: {
                        type: Type.STRING,
                        description: "The action to perform: 'list' (global overview scan), 'check' (check specific device), or 'install' (update specific device).",
                        enum: ['list', 'check', 'install']
                    },
                    deviceName: {
                        type: Type.STRING,
                        description: "Name of the device to manage firmware for (required for 'check' and 'install')."
                    },
                    deviceId: {
                        type: Type.STRING,
                        description: "Device/node UUID. Can be a device ID or a Matter node ID (required for 'check' and 'install')."
                    },
                    softwareVersion: {
                        type: Type.INTEGER,
                        description: "Required for Matter node 'install' action: the target software version number (integer)."
                    },
                    versionString: {
                        type: Type.STRING,
                        description: "No longer used as firmware installation is not supported for non-Matter devices. Do not pass."
                    }
                },
                required: ['action']
            }
        }
    ];
}

module.exports = { getTools };

