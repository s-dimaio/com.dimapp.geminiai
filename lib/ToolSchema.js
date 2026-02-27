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
                        description: "Exact device name (e.g., 'Living Room Light', 'Daikin Studio'). Primary lookup key. Use list_devices_in_zone if you don't know the exact name."
                    },
                    deviceId: {
                        type: Type.STRING,
                        description: "Device UUID. Use ONLY as fallback when control_device returns ambiguous=true (multiple devices share the same name). The correct ID is provided in the matches array of the ambiguity response."
                    },
                    capability: {
                        type: Type.STRING,
                        description: "Capability to control. Common values: 'onoff' (true/false for on/off), 'dim' (0.0-1.0 for brightness), 'target_temperature' (number in degrees), 'volume_set' (0.0-1.0 for volume), 'windowcoverings_state' ('up'/'idle'/'down'). Check device state first to see available capabilities."
                    },
                    value: {
                        description: "Value to set. Type depends on capability: boolean for 'onoff' (true=on, false=off), number 0.0-1.0 for 'dim', number in degrees for 'target_temperature', string for 'windowcoverings_state' or 'thermostat_mode'."
                    }
                },
                required: ['capability', 'value']
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
                        description: 'Name of the device to query'
                    }
                },
                required: ['deviceName']
            }
        },
        {
            name: 'list_flows',
            description: `
                **REQUIRED** to discover and list all Homey Flows (automations).

                **Use this when:**
                - User asks "what flows do I have?", "list my automations"
                - You need to find flow names before calling \`trigger_flow\`
                - User wants to see enabled/disabled flows
                - User asks about flows in a specific folder

                **Flow Types:**
                - **Standard Flow**: Traditional when-and-then flows
                - **Advanced Flow**: Visual canvas-based flows (Homey Pro only)

                **Filters available:**
                - \`enabled\`: true (only active flows), false (only disabled flows), or omit for all
                - \`folder\`: folder name to filter by specific folder
                - \`type\`: 'standard', 'advanced', or 'all' (default: 'all')

                **Returns:**
                - List of flows with: name, id, enabled status, folder, type
                - Summary counts by type and status

                **Examples:**
                - "List all flows" → \`list_flows()\`
                - "Show enabled flows" → \`list_flows({ enabled: true })\`
                - "Show Advanced Flows" → \`list_flows({ type: 'advanced' })\``,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
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
                        description: "Optional filter: 'standard' for standard flows, 'advanced' for Advanced Flows, 'all' for both (default: 'all').",
                        enum: ['standard', 'advanced', 'all']
                    }
                },
                required: []
            }
        },
        {
            name: 'get_flow_info',
            description: `
                Get detailed information about a specific Homey Flow.

                **Use this when:**
                - User asks "tell me about the X flow"
                - You need to check if a flow exists before triggering it
                - User wants details about a specific automation

                **Searches in:**
                - Standard Flows
                - Advanced Flows

                **Returns:**
                - Flow name, id, enabled status
                - Flow type (standard or advanced)
                - Folder location
                - Additional metadata

                **Important:** If flow not found, suggests similar flow names.`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    flowName: {
                        type: Type.STRING,
                        description: "Name of the flow to get information about (e.g., 'Good Morning', 'Movie Time'). Case-insensitive search."
                    }
                },
                required: ['flowName']
            }
        },
        {
            name: 'list_devices_in_zone',
            description: `
                Discover devices in a specific zone/room by name.

                **Returns MINIMAL info only:** name, id, class, available.
                **To get capabilities and available actions:** call \`get_device_details(deviceId)\`.

                **Use this when:**
                - User refers to a room (e.g., "turn off the light in the studio", "what's in the kitchen?")
                - You need to find the exact device name / id before acting
                - Searches recursively (includes sub-zones)

                **Workflow example:**
                1. \`list_devices_in_zone('Studio')\` → find device name + id
                2. \`control_device(name, 'onoff', false)\` for standard capabilities
                   OR \`get_device_details(id)\` if you need capabilities / action cards first`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    zoneName: {
                        type: Type.STRING,
                        description: "Zone/room name to list devices from (e.g., 'Living Room', 'Kitchen', 'Bedroom', 'Studio'). Case-insensitive."
                    }
                },
                required: ['zoneName']
            }
        },
        {
            name: 'list_zones',
            description: `
                Get list of all zones/rooms in the home with their hierarchy.

                **Use this when:**
                - User mentions a room name that might not exist
                - You need to verify zone names before calling other functions

                **Returns:**
                - Zone names
                - Zone IDs
                - Parent zones (if any)`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {},
                required: []
            }
        },
        {
            name: 'list_all_devices',
            description: `
                Discover all devices in the entire home.

                **Returns MINIMAL info only:** name, id, class, zone, available.
                **To get capabilities and available actions:** call \`get_device_details(deviceId)\`.

                **Use this when user asks:**
                - "List all devices"
                - "What devices do I have?"
                - "Show me everything"
                - When you need to see all device names/IDs at once`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {},
                required: []
            }
        },
        {
            name: 'list_devices_by_class',
            description: `
                Discover all devices of a specific type/class.

                **Returns MINIMAL info only:** name, id, class, zone, available.
                **To get capabilities and available actions:** call \`get_device_details(deviceId)\`.

                **Use this when:**
                - You need to find all devices of the same type
                - User asks "show me all lights", "list thermostats"

                **Available classes:**
                \`light\`, \`socket\`, \`thermostat\`, \`lock\`, \`sensor\`, \`speaker\`, \`tv\`, \`fan\`, \`heater\`, \`camera\`, \`doorbell\`, \`blinds\`, \`curtain\`, \`sunshade\`, and more.`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    deviceClass: {
                        type: Type.STRING,
                        description: "Device class to filter by. Common values: 'light', 'socket', 'thermostat', 'sensor', 'lock', 'speaker', 'fan', 'windowcoverings', 'blinds', 'curtain', 'sunshade'"
                    }
                },
                required: ['deviceClass']
            }
        },
        {
            name: 'get_devices_status_by_class',
            description: `
                Get status of **ALL** devices of a specific class with complete state information. Can be filtered by zone.

                **Use this for:**
                - Class-wide status queries like "which lights are on?", "what's the lock status?"
                - Zone-specific queries like "are there lights on in the kitchen?" (with \`zone='Kitchen'\`)
                - This tool searches recursively (includes sub-zones)
                - "What sockets are on?" (no zone parameter)

                **Response Format (Conditional):**
                
                **IF all devices have \`onoff\` capability** (e.g., lights, sockets):
                - Returns: \`summary\` with on/off counts, \`devicesOn\`, \`devicesOff\`
                - Each device includes complete \`state\` object with all capability values
                
                **IF any device lacks \`onoff\`** (e.g., locks, sensors, thermostats):
                - Returns: \`summary\` with total count only, \`devices\` array
                - Each device includes complete \`state\` object with all capability values
                - **Locks**: Check \`state.locked\` (true=locked, false=unlocked)
                - **Sensors**: Check \`state.alarm_motion\`, \`state.alarm_contact\`, etc.
                - **Thermostats**: Check \`state.target_temperature\`, \`state.measure_temperature\`
                - **Window Coverings**: Check \`state.windowcoverings_state\`

                **Always includes:**
                - Zone names for each device
                - **Complete \`state\` object** with ALL capability values
                - **Capabilities list** for proper identification`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    deviceClass: {
                        type: Type.STRING,
                        description: "Device class to query. Common values: 'light', 'socket', 'thermostat', 'fan', 'switch', 'camera', 'lock', 'speaker', 'sensor', 'airconditioning', 'heater'."
                    },
                    zone: {
                        type: Type.STRING,
                        description: "Optional zone/room name to filter results (e.g., 'Kitchen', 'Bedroom', 'Studio'). If omitted, returns devices from all zones."
                    }
                },
                required: ['deviceClass']
            }
        },
        {
            name: 'get_device_count_by_zone',
            description: `
                Get device count and status **SUMMARY** for a specific zone/room.

                **Use this for counting and summary questions:**
                - "How many lights in the bedroom?"
                - "What's on in the kitchen?"
                - "Are there lights on in the studio?"

                **Returns Summary by Device Class (Conditional Format):**
                
                **IF all devices of a class have \`onoff\`** (e.g., lights, sockets):
                - Returns: \`{ total: X, on: Y, off: Z }\`
                
                **IF any device lacks \`onoff\`** (e.g., locks, sensors, thermostats):
                - Returns: \`{ total: X }\` (no on/off counts)
                
                **Example Response:**
                \`\`\`
                byClass: {
                  light: { total: 5, on: 2, off: 3 },  // All lights have onoff
                  lock: { total: 2 }                    // Locks don't have onoff
                }
                \`\`\`

                **Important:** This is the correct tool when user mentions a specific room name for counting or summary.`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    zone: {
                        type: Type.STRING,
                        description: "Zone/room name to get summary for (e.g., 'Living Room', 'Kitchen', 'Bedroom', 'Studio'). Required."
                    }
                },
                required: ['zone']
            }
        },
        // TODO: CANDIDATE FOR REMOVAL to save tokens.
        // Originally needed to translate informal user terms → Homey device class names.
        // Recovery is now handled directly in list_devices_by_class and
        // get_devices_status_by_class errors (availableClasses field + suggestion in error string).
        // Check production logs to verify whether Gemini still invokes this tool; if not,
        // removing it from getTools() eliminates its description from every request context.
        {
            name: 'get_device_class_info',
            description: `
                Look up device class details or search for correct class name.

                **Use this when:**
                - User says plural or informal terms:
                  - "lights" → maps to \`light\`
                  - "plugs" → maps to \`socket\`
                  - "heating" → maps to \`thermostat\` or \`heater\`
                  - "air conditioning" → maps to \`airconditioning\`

                **Returns:**
                - Class details
                - Common capabilities
                - Icon information

                **Essential** for translating user terms to Homey class names.`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    className: {
                        type: Type.STRING,
                        description: "Exact device class name (e.g., 'light', 'socket', 'thermostat', 'airconditioning'). Use this if you know the exact class name."
                    },
                    searchTerm: {
                        type: Type.STRING,
                        description: "Search term to find matching classes (e.g., 'lights', 'plugs', 'heating', 'windows', 'air con'). Use this when translating user's words to class names."
                    }
                }
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
                **To get capabilities and available actions:** call \`get_device_details(deviceId)\`.

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
                        description: 'Exact name of the device to list actions for.'
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
                        description: 'Name of the device (used for context verification)'
                    },
                    cardId: {
                        type: Type.STRING,
                        description: 'The unique ID of the action card to execute (get this from list_device_actions)'
                    },
                    args: {
                        type: Type.OBJECT,
                        description: "Map of arguments required by the card (e.g. { 'brightness': 0.5 }). Empty object if no args."
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
                        description: 'Name of the device (camera, doorbell, etc.) to get the image from'
                    }
                },
                required: ['deviceName']
            }
        },
        {
            name: 'get_device_history',
            description: `
                Get historical data and logs for a specific device.
                
                **Use this when:**
                - User asks about past values (e.g., "what was the temperature yesterday?")
                - User wants to see trends or patterns
                - User asks about energy consumption over time
                - User wants statistics (average, min, max)
                
                **Returns:**
                - List of available logs for the device (e.g., temperature, humidity, power consumption)
                - Each log includes: name, units, type, and available time ranges
                
                **Important:** This tool only lists WHAT logs are available. Use \`get_log_entries\` to get actual historical data.
                
                **Examples:**
                - "What logs are available for the bedroom thermostat?"
                - "Show me the history of the living room light"`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    deviceName: {
                        type: Type.STRING,
                        description: "Exact name of the device to get history for (e.g., 'Living Room Thermostat', 'Kitchen Light')"
                    }
                },
                required: ['deviceName']
            }
        },
        {
            name: 'get_log_entries',
            description: `
                Get actual time-series data from a device log.
                
                **Use this when:**
                - User wants actual historical values
                - User asks for trends, averages, statistics
                - User wants to compare values over time
                
                **Resolution options:**
                - \`last24Hours\` - Hourly data for the last 24 hours
                - \`last7Days\` - Daily data for the last 7 days  
                - \`last14Days\` - Daily data for the last 14 days
                - \`last31Days\` - Daily data for the last 31 days
                - \`last6Months\` - Weekly data for the last 6 months
                - \`last1Years\` - Monthly data for the last year
                - \`last5Years\` - Yearly data for the last 5 years
                
                **Returns:**
                - Array of data points with timestamp (in LOCAL time, not UTC) and value
                - Timezone information
                - Statistics (min, max, average) for the data
                - You can then analyze this data to answer user questions
                
                **Examples:**
                - "Get temperature data for bedroom for the last week"
                - "Show power consumption of washing machine for last 24 hours"`,
            inputSchema: {
                type: Type.OBJECT,
                properties: {
                    deviceName: {
                        type: Type.STRING,
                        description: 'Exact name of the device'
                    },
                    logId: {
                        type: Type.STRING,
                        description: 'ID of the log to retrieve (get this from get_device_history first)'
                    },
                    resolution: {
                        type: Type.STRING,
                        description: "Time resolution for the data. Options: 'last24Hours', 'last7Days', 'last14Days', 'last31Days', 'last6Months', 'last1Years', 'last5Years'",
                        enum: ['last24Hours', 'last7Days', 'last14Days', 'last31Days', 'last6Months', 'last1Years', 'last5Years']
                    }
                },
                required: ['deviceName', 'logId', 'resolution']
            }
        }
    ];
}

module.exports = { getTools };
