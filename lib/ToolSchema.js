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
                **Fallback:** If the specific command is not available here (e.g. "reset", "start program"), check \`list_device_actions\`.`,
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
        },
        {
            name: 'discover_devices',
            description: `
                Discover devices in the home.

                **Returns MINIMAL info only:** name, id, class, zone, available.
                **To get capabilities and available actions:** call \`get_device_state(deviceName)\` and \`list_device_actions(deviceName)\`.

                **Use this when:**
                - User asks to list all devices (no parameters)
                - User asks about devices in a specific room (use \`zoneName\`)
                - User asks about specific types of devices like lights or thermostats (use \`deviceClass\`)
                - Combinations: "what lights are in the kitchen?" (use both \`zoneName\` and \`deviceClass\`)

                **Available classes:** \`light\`, \`socket\`, \`thermostat\`, \`lock\`, \`sensor\`, \`speaker\`, \`tv\`, \`fan\`, \`heater\`, \`camera\`, \`doorbell\`, \`blinds\`, \`curtain\`, \`sunshade\`, and more.
                
                **Workflow example:**
                1. \`discover_devices({zoneName: 'Studio'})\` → find device name + id
                2. \`control_device(name, 'onoff', false)\` for standard capabilities
                   OR \`get_device_state(name)\` / \`list_device_actions(name)\` if you need capabilities / action cards first`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    zoneName: {
                        type: Type.STRING,
                        description: "Optional. Zone/room name to filter by (e.g., 'Living Room', 'Kitchen', 'Bedroom', 'Studio'). Case-insensitive. Searches recursively including sub-zones."
                    },
                    deviceClass: {
                        type: Type.STRING,
                        description: "Optional. Device class to filter by. Common values: 'light', 'socket', 'thermostat', 'sensor', 'lock', 'speaker', 'fan', 'windowcoverings', 'blinds', 'curtain', 'sunshade'"
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
            name: 'schedule_command',
            description: `
                Schedule a command to be executed at a future time.

                **Use this when user wants to perform an action later:**
                - "Turn off lights at 5pm tomorrow"
                - "Turn on heating in 30 minutes"
                - "Set temperature to 21°C at 7am Monday"
                - "Start washing machine in 2 hours"

                **Features:**
                - Supports scheduling up to **365 days** in advance
                - Precise execution for times within 24 hours
                - Command will be executed automatically at the specified time

                **Format Requirements:**
                - \`executeAt\` accepts time in **Homey's local timezone**
                - Format: \`YYYY-MM-DDTHH:MM:SS\` (without timezone suffix)
                - Calculate times naturally in local time - conversion is automatic`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    command: {
                        type: Type.STRING,
                        description: "The natural language command to execute later (e.g., 'turn off all lights in living room', 'set thermostat to 20 degrees'). This will be processed through Gemini at execution time."
                    },
                    executeAt: {
                        type: Type.STRING,
                        description: "ISO 8601 datetime in LOCAL time (Homey's timezone), format: 'YYYY-MM-DDTHH:MM:SS' (e.g., '2026-02-08T22:00:00'). Pass the time in Homey's local timezone - the system will automatically convert to UTC internally. Current local time is provided in the system instructions."
                    },
                    description: {
                        type: Type.STRING,
                        description: "Human-readable description of what will happen (e.g., 'Turn off lights at 5pm tomorrow', 'Start heating in 30 minutes')."
                    }
                },
                required: ['command', 'executeAt', 'description']
            }
        },
        {
            name: 'search_devices',
            description: `
                Search for devices by matching keywords in their names.

                **Returns MINIMAL info only:** name, id, class, zone, available.
                **To get capabilities and available actions:** call \`get_device_state(deviceName)\` and \`list_device_actions(deviceName)\`.

                **CRITICAL SEARCH INSTRUCTIONS:**
                1.  **MULTI-LANGUAGE QUERY REQUIRED**: You **MUST** include search terms in **BOTH** English and User's Language.
                2.  **FUZZY MATCHING (Refusi & Varianti)**: The system uses strict text matching. You MUST simulate fuzzy matching by providing:
                    *   **Common Typos**: (e.g. "light" -> "lght, lihgt, lite")
                    *   **Phonetic Variations**: (e.g. "Philips" -> "Phillips, Filips")
                    *   **Synonyms**: (e.g. "monitor" -> "display, screen, tv")
                3.  **FORMAT**: Separate ALL keywords with commas.

                *Example:* User asks for "Luce Cucina" (Italian):
                *Query:* \`"luce, light, lamp, cucina, kitchen, kitch, cucin, cook, food"\`

                **Use this when:**
                - User describes a device function but device has a specific name.
                - Broad class searches fail.
                - You suspect a typo in the user's request.

                **Returns:**
                - Devices matching **ANY** of the provided keywords (case-insensitive partial match).`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    query: {
                        type: Type.STRING,
                        description: "Comma-separated list of keywords in BOTH English and User's language (e.g. 'presence, motion, presenza, movimento')."
                    }
                },
                required: ['query']
            }
        },
        {
            name: 'list_device_actions',
            description: `
                List all specialized actions (Flow Cards) available for a specific device.

                **Use this when:**
                - User asks "what can I do with the [device]?"
                - User wants to perform a specific action not covered by standard controls (e.g. "reset meter", "set specific mode")
                - You need to find the card ID to use with \`run_action_card\`

                **Returns:**
                - List of action cards with IDs and required arguments
                - **Output tokens**: Each card includes \`tokens\` array showing what data it returns (text, number, boolean, image)
                - **CRITICAL:** You MUST read the \`title\` and \`description\` of each card to understand what it does`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    deviceName: {
                        type: Type.STRING,
                        description: 'Exact name of the device to list actions for. MUST be provided in all requests.'
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
        }
    ];
}

module.exports = { getTools };
