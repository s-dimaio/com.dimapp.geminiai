Send prompts to Google Gemini from Homey Flows and use the AI's answer in your automations. If used together with a Telegram account you can create custom bots for managing your home.

Features
- Text Prompts: send questions or instructions and receive AI-generated responses.
- Image Prompts: analyze images (e.g. from cameras) to describe what's happening at home.
- Smart Home Control: use natural language to control devices, ask about your home status, or trigger Flows.
- Scheduled Automations: ask Gemini to run a command at a specific time. Manage timers in the app settings.
- Model Selection: choose from the latest Gemini models (Flash, Pro, Gemini 3) for superior speed or intelligence.

Usage Examples
```
WHEN: A Telegram message with smart home command is received (e.g. switch off all lights)
THEN: Send prompt to Gemini AI with Telegram message
AND: Send a Telegram message with Gemini reply
```
```
WHEN: Motion is detected in the living room
THEN: Send Prompt "Generate a welcoming message for someone entering the living room"
AND: Speak the Gemini answer
```
```
WHEN: Doorbell camera detects motion
THEN: Send Prompt with Image "Describe what you see in this image and identify any people or packages"
AND: Send notification with Gemini analysis
```
```
WHEN: Security sensor triggers
THEN: Take a snapshot with camera
AND: Send Prompt with Image "Analyze this security camera image and describe any potential threats"
AND: Log the analysis result
```
```
WHEN: Motion detected in storage room
THEN: Capture image from security camera
AND: Send Prompt with Image "Check if anything appears disturbed or out of place in this storage area. Reply with 'true' if everything is OK, otherwise reply with 'false'"
AND: Manage true/false response in flows
```
```
WHEN: It is the weekend 
THEN: Send an "Ask question" notification with the text: "The weekend is almost here. What would you like me to do?" 
AND: Send a Prompt with the user response: "Start heating the house tomorrow at 6:00 PM" 
AND: Process the response and verify successful execution
```

Requirements
- A valid Google Gemini API Key.
- **HomeyScript**: Must be installed to enable flow triggering and advanced device actions.

Setup
1) Open the app’s Settings and insert your API Key.
2) Select the Gemini Model you want to use.
3) Create a Flow and add an action card from the Gemini app.
4) Use the returned tokens (e.g., `answer`, `response`, `success`) in subsequent Flow cards.

Privacy
- Your API Key is stored securely on your Homey.
- Prompts and images are sent to Google's API only when a Flow is executed.