# Gemini AI

**Invia prompt a Google Gemini dai Flow di Homey e usa le risposte dell'IA nelle tue automazioni.**

Questa app per Homey integra l'IA Gemini di Google nel tuo ecosistema smart home, permettendoti di creare automazioni intelligenti. Invia prompt di solo testo o multimodali (testo + immagine) a Gemini direttamente dai Flow, oppure usa comandi conversazionali per controllare l'intera casa con il linguaggio naturale.

## Funzionalità

- **Prompt di Testo**: Scheda azione "Invia un prompt" che accetta testo e restituisce risposte generate dall'IA.
- **Analisi Immagini**: Scheda azione "Invia un prompt con immagine" per prompt multimodali (immagine + testo).
- **Controllo Smart Home (Function Calling)**: Scheda azione "Esegui un comando per la tua smart home" per il controllo conversazionale - chiedi a Gemini di controllare dispositivi, attivare flow e interrogare lo stato della casa.
- **Gestione Cronologia**: Memoria della conversazione persistente per sessioni multi-turno coerenti.
- **Automazioni Pianificate**: Pianifica comandi da eseguire in futuro (es. "Tra 10 minuti spegni le luci").
- **Logica di Retry**: Gestione intelligente dei limiti di quota (errori 429) con tentativi automatici.
- **Selezione Modello**: Scegli tra i modelli Gemini (Flash, Pro, Gemini 3) nelle impostazioni per bilanciare velocità e prestazioni.
- **Supporto Token**: Restituisce vari token (risposta, successo, ID timer) utilizzabili nelle schede Flow successive.
- **Integrazione Immagini**: Supporto completo per i token immagine di Homey (es. snapshot da webcam).

## Requisiti

- Homey Pro con firmware >=12.4.0
- Chiave API Google Gemini (disponibile piano gratuito)
- **HomeyScript**: Necessario per l'attivazione dei Flow e l'esecuzione di azioni avanzate sui dispositivi.

## Installazione

### Da Homey App Store
1. Apri l'app Homey sul tuo dispositivo
2. Vai su "Altro" → "App"
3. Cerca "Gemini for Homey"
4. Installa l'app

### Per Sviluppo
1. Clona questo repository
2. Installa le dipendenze: `npm install`
3. Usa la CLI di Homey per eseguire: `homey app run`

## Configurazione Chiave API Google Gemini

### Passo 1: Accedi a Google AI Studio
1. Vai su [Google AI Studio](https://aistudio.google.com/)
2. Accedi con il tuo account Google

### Passo 2: Crea una Chiave API
1. Clicca su "Get API Key" nella barra laterale
2. Clicca "Create API key in new project"
3. La tua chiave verrà generata automaticamente

### Informazioni sui Prezzi
- Google Gemini API offre un piano gratuito generoso (fino a 15 richieste al minuto).
- Per i dettagli aggiornati, visita [Google AI Pricing](https://ai.google.dev/pricing).

## Configurazione App

1. Apri l'app Homey → "Altro" → "App" → "Gemini for Homey" → "Impostazioni".
2. Inserisci la tua Chiave API.
3. Seleziona il Modello Gemini preferito.
4. Clicca "Salva".

## Esempi di Utilizzo

### Controllo Conversazionale Dispositivi
```
QUANDO: Ricevuto comando vocale
ALLORA: Esegui un comando per la tua smart home "Spegni tutte le luci in soggiorno"
E: Pronuncia la risposta
```

### Analisi Immagine con Webcam
```
QUANDO: Il campanello rileva movimento
ALLORA: Invia un prompt con immagine "Descrivi cosa vedi in questa immagine e identifica persone o pacchi"
E: Invia notifica con l'analisi di Gemini
```

### Query Smart Home
```
QUANDO: Pianificazione attivata
ALLORA: Esegui un comando per la tua smart home "Quali luci sono accese in cucina?"
E: Registra la risposta (log)
```

## Dettagli Tecnici

### Dipendenze Principali
- `@google/genai`: SDK ufficiale Google Generative AI (v1.38.0+)
- `homey-api`: Client Homey API (v3.16.0+)
- `homey`: Homey Apps SDK v3

### Schede Flow (Azioni)

#### Invia un prompt (Solo Testo)
- **Input**: Prompt testuale
- **Output**: Token `answer` con la risposta di Gemini

#### Invia un prompt con immagine (Multimodale)
- **Input**: Token immagine + Prompt testuale
- **Output**: Token `answer` con la risposta di Gemini

#### Esegui un comando per la tua smart home (Function Calling)
Questa azione utilizza il Model Context Protocol (MCP) per interagire con Homey. Gemini decide autonomamente quali strumenti usare tra i 16 disponibili:

**Strumenti Principali:**
- `control_device`: Controlla qualsiasi dispositivo (on/off, luminosità, temperatura, etc.).
- `trigger_flow`: Avvia un Flow di Homey per nome.
- `get_device_state`: Interroga lo stato attuale di un dispositivo.
- `list_devices_in_zone`: Elenca i dispositivi in una zona/stanza specifica.
- `get_devices_status_by_class`: Stato di tutti i dispositivi di una classe (es. "quali luci sono accese?").
- `search_devices`: Ricerca avanzata (fuzzy) di dispositivi per parole chiave.
- `schedule_command`: Pianifica l'esecuzione di comandi futuri.
- `list_flows` / `get_flow_info`: Scoperta e dettagli delle automazioni esistenti.
- `list_device_actions` / `run_action_card`: Esecuzione di azioni specifiche (Action Cards) non standard.

**Note Tecniche:**
- Richiede il permesso `homey:manager:api`.
- Funziona solo su installazioni Homey locali (non Homey Cloud).

## Privacy e Sicurezza

- **Conservazione Chiave API**: Memorizzata in modo sicuro nelle impostazioni di Homey.
- **Elaborazione Dati**: Prompt, immagini e risposte sono elaborati dalle API Google Gemini.
- **Nessuna Ritenzione Locale**: L'app non memorizza prompt o analisi generate.

## Risoluzione dei Problemi

**"HomeyScript app is NOT installed"**
- Installa l'app HomeyScript dallo store ufficiale per abilitare l'attivazione dei Flow e le azioni sui dispositivi.

**"Quota exceeded" (429)**
- Gemini Client implementa un sistema di retry automatico, ma se l'errore persiste verifica i limiti del tuo piano su Google AI Studio.

## Supporto
- **Segnalazioni**: [GitHub Issues](https://github.com/s-dimaio/com.dimapp.geminiai/issues)
- **Documentazione**: [Gemini API Docs](https://ai.google.dev/gemini-api/docs)

---
**Autore**: Simone Di Maio
**Licenza**: GNU General Public License v3.0

