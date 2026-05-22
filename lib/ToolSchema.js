'use strict';

const { Type } = require('@google/genai');

/**
 * Returns the complete list of MCP tool definitions in Gemini function-calling format.
 *
 * This module is intentionally a pure function with no dependencies on `HomeyMCPAdapter`
 * or any Homey runtime objects. Keeping tool schemas separate from the adapter logic makes
 * them easier to maintain and review without touching device/flow/scheduling code.
 *
 * @public
 * @returns {Object[]} Array of MCP tool definition objects.
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

                **Important:** You must use exact device name and correct capability name.
                **Fallback:** If the specific command is not available here (e.g. "reset", "start program"), check \`discover_flow_cards\`.`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    deviceName: {
                        type: Type.STRING,
                        description: "Exact device name. MUST be provided in all requests. Gemini infers this from user queries or discovers it via discover_devices."
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
                        description: "Value to set. Type depends on capability: boolean for 'onoff' (true=on, false=off), number 0.0-1.0 for 'dim', number in degrees for 'target_temperature', string for 'windowcoverings_state' or 'thermostat_mode'."
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
                        description: "Exact name of the Flow to trigger (e.g., 'Good Morning', 'Evening Lights', 'Away Mode'). Flow name must match exactly as defined in Homey."
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

                **Important:** This is your ONLY way to read device states.`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    deviceName: {
                        type: Type.STRING,
                        description: "Name of the device to query. MUST be provided in all requests."
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
        },        {
            name: 'discover_resources',
            description: `
                Discover devices, user-installed apps, or built-in system managers in Homey.

                **Returns MINIMAL info only:** name, id, class, zone, available (for devices) or ownerUri (for apps/managers).
                **To get capabilities and available actions:** call \`get_device_state(deviceName)\` and \`discover_flow_cards(deviceName)\`.

                **Use this when:**
                - User asks to list or search devices, apps, or system integrations.
                - You need to find devices in a specific room (use \`zoneName\`) or of a specific type (use \`deviceClass\`).
                - You need to search for a resource by keyword or name (use \`query\`).
                - You need to find the ownerUri of an app or manager before discovering its flow cards (use \`type='app'\` or \`type='system'\`).

                **Available classes:** \`light\`, \`socket\`, \`thermostat\`, \`lock\`, \`sensor\`, \`speaker\`, \`tv\`, \`fan\`, \`heater\`, \`camera\`, \`doorbell\`, \`blinds\`, \`curtain\`, \`sunshade\`, etc.`,
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
                
                **Specific States:**
                - **Locks**: Check \`state.locked\` (true=locked, false=unlocked)
                - **Sensors**: Check \`state.alarm_motion\`, \`state.alarm_contact\`, etc.
                - **Thermostats**: Check \`state.target_temperature\`, \`state.measure_temperature\`
                - **Window Coverings**: Check \`state.windowcoverings_state\``,
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
                        description: "Required for 'create': The natural language command to execute. MUST NOT contain time references (e.g. 'turn off lights')."
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
                - For \`cardType='trigger'\` or \`'condition'\`: you MUST provide either \`deviceName\` (for device-based cards) OR \`ownerUri\` (for app/system manager cards). Obtain \`ownerUri\` via \`discover_devices(type='app'|'system')\`.
                - If neither filter is provided for trigger/condition, the tool will return an error.

                **Returns:**
                - List of cards with \`id\`, \`title\`, \`args\` (arguments required to configure the card)
                - For action cards: also includes \`tokens\` (output tokens the card produces)`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    cardType: {
                        type: Type.STRING,
                        description: "Type of flow card to discover. 'action' (default): action cards for a device, used with run_action_card or manage_flow. 'trigger': trigger cards for a device, app or system manager — use before manage_flow to find the trigger. 'condition': condition cards — use before manage_flow to find conditions.",
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
                        description: "Filter trigger/condition cards by their owner's URI (e.g. 'homey:app:com.athom.homeyscript', 'homey:manager:clock'). Obtain this value from discover_devices(type='app') or discover_devices(type='system'). Use instead of deviceName for non-device triggers."
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
                - You want to execute a specific action found via \`list_device_actions\`
                - User requests a device-specific command (e.g. "Reset energy meter on Socket A", "Take camera snapshot")

                **Returns:**
                - Success confirmation
                - **Image tokens**: If the action card produces an image (e.g., camera snapshot), the image will be automatically included for visual analysis
                - **Other tokens**: Text/number/boolean tokens returned by the action card (if any)

                **Requirements:**
                - You must have the \`cardId\` (from \`list_device_actions\`)
                - You must provide any required arguments map`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    deviceName: {
                        type: Type.STRING,
                        description: 'Name of the device. MUST be provided in all requests.'
                    },
                    deviceId: {
                        type: Type.STRING,
                        description: "Device UUID. Use ONLY as a fallback if this tool previously returned ambiguous=true. Do not guess UUIDs."
                    },
                    cardId: {
                        type: Type.STRING,
                        description: 'The unique ID of the action card to execute (get this from list_device_actions)'
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
                        description: 'Name of the device. MUST be provided in all requests.'
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
                        description: "Exact name of the device. MUST be provided in all requests."
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
                        description: "Optional. Time resolution for the data. Must be provided if logId is provided.",
                        enum: ['last24Hours', 'last7Days', 'last14Days', 'last31Days', 'last6Months', 'last1Years', 'last5Years']
                    }
                },
                required: ['deviceName']
            }
        },
        {
            name: 'manage_flow',
            description: `
                Create, update, or delete a Standard Homey Flow.

                **IMPORTANT:** This tool works on Standard Flows ONLY. Advanced Flows cannot be managed via this tool.

                **Use this when:**
                - User asks to create a new automation flow
                - User asks to modify an existing flow (rename, change trigger/conditions/actions)
                - User asks to delete an existing flow

                **Workflow BEFORE calling manage_flow(action='create'):**

                For DEVICE triggers (e.g. 'when motion detected', 'when light turned on'):
                  1. discover_flow_cards(cardType='trigger', deviceName='...') → get trigger card id
                  2. (Optional) discover_flow_cards(cardType='condition', deviceName='...') → get condition card id
                  3. discover_flow_cards(cardType='action', deviceName='...') for each action device
                  4. manage_flow(action='create', ...)

                For APP triggers (e.g. 'when HomeyScript X runs'):
                  1. discover_devices(type='app') → get app ownerUri
                  2. discover_flow_cards(cardType='trigger', ownerUri='...') → get trigger card id
                  3. discover_flow_cards(cardType='action', deviceName='...') for each action
                  4. manage_flow(action='create', ...)

                For SYSTEM triggers (e.g. 'every day at 8am', 'when I arrive home', 'at sunrise'):
                  1. discover_devices(type='system') → get system manager ownerUri
                  2. discover_flow_cards(cardType='trigger', ownerUri='...') → get trigger card id
                  3. discover_flow_cards(cardType='action', deviceName='...') for each action
                  4. manage_flow(action='create', ...)

                **Flow object format:**
                - \`trigger\`: { id: cardId, args: {} }  — NO \`uri\` field
                - \`conditions\`: array of { id, args, inverted? } — can be empty [] — NO \`uri\` field
                - \`actions\`: array of { id, args, group: 'then', delay, duration: null } — MUST have at least one item — NO \`uri\` field
                  - \`delay\` should be null OR an object if a delay is requested: { enabled: true, number: "10", multiplier: 1 } (multiplier: 1=sec, 60=min. Convert hours to minutes).`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    action: {
                        type: Type.STRING,
                        description: "Operation to perform: 'create' (new flow), 'update' (modify existing flow), 'delete' (remove existing flow).",
                        enum: ['create', 'update', 'delete']
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
                        description: "Trigger card configuration. Required for 'create'. Format: { id: string, args: object }. The 'id' is the full trigger card ID as returned by discover_flow_cards (e.g. 'homey:manager:cron:time_exactly'). Do NOT include a 'uri' field. CRITICAL: When updating a flow and changing the trigger card, you MUST completely replace 'args' with ONLY the exact arguments accepted by the new trigger card schema. Never carry over arguments from the previous trigger."
                    },
                    conditions: {
                        type: Type.ARRAY,
                        description: "Array of condition card configurations. Can be empty []. Each: { id: string, args: object, inverted?: boolean }. Do NOT include a 'uri' field. CRITICAL: When updating a flow and replacing a condition card, you MUST completely replace its 'args' object to match the new card's schema as returned by discover_flow_cards.",
                        items: { type: Type.OBJECT }
                    },
                    actions: {
                        type: Type.ARRAY,
                        description: "Array of action card configurations. Must contain at least one item for 'create'. Each action MUST have exactly these fields: { id: string, args: object, group: 'then', delay: <DelayObject|null>, duration: null }. DelayObject format is { enabled: true, number: '10', multiplier: 1 } (multiplier is strictly 1 for seconds, 60 for minutes. If the user specifies hours, convert them to minutes, e.g. 1.5 hours = 90 minutes). Set delay to null if no delay is requested. The 'id' is the full action card ID as returned by discover_flow_cards (e.g. 'homey:device:UUID:off'). Do NOT include a 'uri' field. CRITICAL: When updating a flow and changing or replacing an action card, you MUST discard the old 'args' object completely and populate 'args' with ONLY the exact arguments accepted by the new card schema. NEVER carry over parameters (like 'message') from the previous action card.",
                        items: { type: Type.OBJECT }
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
        }
    ];
}

module.exports = { getTools };
