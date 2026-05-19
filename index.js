require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const Stripe = require('stripe');
const { google } = require('googleapis');
const dialogflow = require('@google-cloud/dialogflow');
const uuid = require('uuid');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the Frontend React/HTML files statically
app.use(express.static('public'));

// ----------------------------------------------------
// Human Handoff (Live Chat) State Management
// ----------------------------------------------------
const pendingMessages = {}; // Stores messages from Admin to User: { sessionId: ["msg1", "msg2"] }
let currentActiveUser = null; // Tracks the current user the Admin is talking to

function sendTelegramMessage(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.ADMIN_CHAT_ID;
    if (!token || !chatId) return;

    const data = JSON.stringify({ chat_id: chatId, text: text });
    const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
            if (res.statusCode !== 200) {
                console.error(`[Telegram Error]: Failed to send message. Status: ${res.statusCode}, Body: ${body}`);
            } else {
                console.log("[Telegram] Notification sent successfully!");
            }
        });
    });
    req.on('error', e => console.error("[Telegram Network Error]:", e.message));
    req.write(data);
    req.end();
}

// Telegram Webhook: Receives replies from the Admin
app.post('/telegram-webhook', (req, res) => {
    console.log("[DEBUG] Webhook hit! Body:", JSON.stringify(req.body));
    const msg = req.body.message || req.body.edited_message;
    
    if (msg && msg.text) {
        const text = msg.text.trim();
        
        // Command to end the Live Chat and hand control back to the Gemini Bot
        if (text.toLowerCase() === '/end' || text.toLowerCase() === '/exit') {
            if (currentActiveUser) {
                if (!pendingMessages[currentActiveUser]) {
                    pendingMessages[currentActiveUser] = [];
                }
                pendingMessages[currentActiveUser].push("🔴 Our expert has disconnected. The AI Assistant is back online to help you!");
                sendTelegramMessage("🔴 *Live Chat Ended!* Control is handed back to the AI Bot.");
                currentActiveUser = null;
            } else {
                sendTelegramMessage("⚠️ No active user session to end.");
            }
            return res.sendStatus(200);
        }

        if (currentActiveUser) {
            if (!pendingMessages[currentActiveUser]) {
                pendingMessages[currentActiveUser] = [];
            }
            pendingMessages[currentActiveUser].push(text);
            console.log(`✅ [Live Chat] Saved admin reply for user ${currentActiveUser}: ${text}`);
        } else {
            console.log(`⚠️ [Live Chat] Admin replied, but no user is currently active (currentActiveUser is null).`);
        }
    } else {
        console.log(`⚠️ [Live Chat] Received webhook without valid text message.`);
    }
    res.sendStatus(200);
});

// Polling Endpoint: Allows frontend to check if Admin sent any new messages
app.get('/api/poll', (req, res) => {
    const { sessionId } = req.query;
    if (pendingMessages[sessionId] && pendingMessages[sessionId].length > 0) {
        const msgs = [...pendingMessages[sessionId]];
        pendingMessages[sessionId] = []; // Clear queue after reading
        return res.json({ messages: msgs });
    }
    return res.json({ messages: [] });
});
// ----------------------------------------------------

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'dummy_key_id',
    key_secret: process.env.RAZORPAY_SECRET || 'dummy_secret',
});
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'dummy_stripe_key');

const SCOPES = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/spreadsheets'
];
const auth = new google.auth.GoogleAuth({
    keyFile: './credentials.json',
    scopes: SCOPES,
});
const calendar = google.calendar({ version: 'v3', auth });
const sheets = google.sheets({ version: 'v4', auth });

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const DIALOGFLOW_PROJECT_ID = process.env.DIALOGFLOW_PROJECT_ID || 'ai-booking-agent-496613';
const sessionClient = new dialogflow.SessionsClient({ keyFilename: './credentials.json' });

function structProtoToJson(proto) {
    if (!proto || !proto.fields) return {};
    const json = {};
    for (const key in proto.fields) {
        const value = proto.fields[key];
        if (value.stringValue !== undefined) json[key] = value.stringValue;
        else if (value.numberValue !== undefined) json[key] = value.numberValue;
        else if (value.boolValue !== undefined) json[key] = value.boolValue;
        else if (value.listValue !== undefined) json[key] = value.listValue.values.map(v => v.stringValue);
    }
    return json;
}

// ----------------------------------------------------
// Universal Auto-Translator (Free Google API)
// ----------------------------------------------------
function translateText(text, sourceLang, targetLang) {
    return new Promise((resolve) => {
        if (!text) return resolve(text);
        
        const sl = sourceLang === 'auto' ? 'auto' : sourceLang.split('-')[0];
        const tl = targetLang.split('-')[0];
        
        if (sl === tl) return resolve(text);
        
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
        const options = {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        };
        
        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    let translated = '';
                    parsed[0].forEach(item => translated += item[0]);
                    resolve(translated);
                } catch (e) {
                    resolve(text);
                }
            });
        }).on('error', () => resolve(text));
    });
}

async function saveDataToSheet(date, customerName, phone, issue, appointmentTime, paymentStatus) {
    if (!SHEET_ID) {
        console.warn("⚠️ Google Sheet ID is missing in .env!");
        return;
    }
    try {
        console.log(`📊 [Sheets API] Attempting to append lead to Sheet ID: ${SHEET_ID}...`);
        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: 'A:F',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[date, customerName, phone, issue, appointmentTime, paymentStatus]] }
        });
        console.log(`📊 [Sheets API] Lead successfully saved to Google Sheet!`);
    } catch (error) {
        console.error("❌ Google Sheets API Error:", error.message);
    }
}

const fetch = require('node-fetch');
const groqSessions = {};

// Helper to check if a specific date and time slot is already booked in Google Calendar
async function isSlotBooked(dateStr, timeStr) {
    if (!process.env.GOOGLE_CALENDAR_ID) return false;
    try {
        // e.g. "2026-05-20T10:00:00"
        const startDateTime = new Date(`${dateStr}T${timeStr}:00`);
        const endDateTime = new Date(startDateTime.getTime() + 30 * 60 * 1000); // 30-min duration
        
        const response = await calendar.events.list({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            timeMin: startDateTime.toISOString(),
            timeMax: endDateTime.toISOString(),
            singleEvents: true
        });
        
        return response.data.items && response.data.items.length > 0;
    } catch (err) {
        console.error("⚠️ Error checking calendar slot:", err.message);
        return false;
    }
}

const SYSTEM_PROMPT = `You are a highly professional, polite, and human-like AI receptionist for an appointment booking system.
YOUR MISSION:
Help the user book an appointment by collecting exactly 5 details step-by-step.

IMPORTANT RULES:
1. LANGUAGE: Always respond in the EXACT SAME LANGUAGE the user speaks (e.g., Hindi, Hinglish, English). If they use Hinglish (Hindi written in English alphabets like "hello bhai booking karni hai"), reply in Hinglish.
2. STEP-BY-STEP FLOW: Ask for details ONE BY ONE. Never ask for multiple details in a single message.
   - STEP 1 (Greeting & Name): When the user first says "hi", "hello", "namaste", "hey" or starts the chat, warmly welcome them, introduce yourself, and ask ONLY for their Name (नाम).
   - STEP 2 (Phone Number): Once they tell you their name (e.g. "I am Rohan", "mera naam Rohan hai", "Rohan here", or just "Rohan"), acknowledge it warmly (e.g., "Nice to meet you Rohan!") and then ask ONLY for their Phone Number (फ़ोन नंबर).
   - STEP 3 (Issue/Reason): Once they give their phone number, ask ONLY for their Issue/Reason for booking (अपॉइंटमेंट का कारण).
   - STEP 4 (Date): Once they state their issue, ask ONLY for their preferred Appointment Date (तारीख).
   - STEP 5 (Time): Ask for their preferred Time slot (समय).
3. STRICT PHONE NUMBER VALIDATION: The phone number MUST consist strictly of numerical digits only (e.g., 9876543210). If the user types any alphabetic letters, words, or non-numeric characters, you MUST politely reject it in their language and ask them to provide numbers/digits only.
4. DATE & TIME PICKER: When asking the user to select their Appointment Date or Appointment Time, you MUST always append the exact secret tag: [SHOW_DATE_TIME_PICKER] at the very end of your response, so the user can easily select Month, Year, Day, and Time from the dropdown card.
5. FLEXIBLE NAME PARSING: Be smart! People might state their name in different ways (e.g., "Mera naam Rohan hai", "I'm Rohan", or just "Rohan"). Identify the name accurately. If you are unsure, ask politely to confirm.
6. SECRET BOOKING TAG: Once and ONLY once all 5 details are successfully collected and confirmed, you MUST append this exact secret tag at the very end of your final confirmation message:
   [BOOKING_READY: {"name":"their name", "phone":"their phone", "issue":"their issue", "date":"YYYY-MM-DD", "time":"HH:MM"}]
   (Make sure date is YYYY-MM-DD and time is HH:MM).
7. Keep all responses very warm, polite, and concise (1-2 sentences maximum).`;

app.post('/api/chat', async (req, res) => {
    try {
        const { text, sessionId, languageCode = 'en-US' } = req.body;
        if (!text) return res.status(400).json({ error: "Text is required" });

        const currentSessionId = sessionId || uuid.v4();
        let messages = [];

        // If already in a Live Chat with the Admin, just forward message to Telegram and bypass Gemini
        if (currentActiveUser === currentSessionId) {
            sendTelegramMessage(`💬 *User:* ${text}`);
            return res.json({
                reply: null,
                messages: [],
                intent: "Live_Chat"
            });
        }

        // Check for Human Handoff / Contact Intent (Telegram Handoff)
        const lowerText = text.toLowerCase();
        const handoffRegex = /\b(buy|purchase|price|kharidna|banwana|interest|agent|bot chahiye|cost|owner|human|manushya|baat|contact|support|customer care|live chat|online agent|admin|talk|help|call)\b/i;
        
        if (handoffRegex.test(lowerText)) {
            currentActiveUser = currentSessionId; // Set this user as active for Admin
            sendTelegramMessage(`🔥 *Live Chat Handoff Requested!*\n👤 Session: \`${currentSessionId}\`\n💬 Msg: "${text}"\n\nReply directly to this Telegram message to chat with them. Your number will remain 100% hidden.`);
            
            const handoffReply = languageCode.startsWith('hi')
                ? "मैं आपको सीधे हमारे लाइव सपोर्ट / ओनर से कनेक्ट कर रहा हूँ। कृपया यहाँ अपना मैसेज लिखें, ओनर अभी लाइव जवाब देंगे! 🤝"
                : "Connecting you directly to our live support / owner. Please type your message here, the owner will reply live! 🤝";
                
            return res.json({
                reply: handoffReply,
                messages: [],
                intent: "Human_Handoff"
            });
        }

        // --- SUPER AI: GROQ CLOUD DUAL-ENGINE LOGIC ---
        if (!groqSessions[currentSessionId]) {
            groqSessions[currentSessionId] = [
                { role: "system", content: SYSTEM_PROMPT }
            ];
        }

        // Push new user message
        groqSessions[currentSessionId].push({ role: "user", content: text });

        // Dynamically enforce frontend-selected language code
        const langCodeShort = languageCode.split('-')[0];
        const langName = langCodeShort === 'hi' ? 'Hindi (हिन्दी) or Hinglish (Hindi written in English text)' : 'English';
        
        const apiMessages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "system", content: `STRICT RULE: The user has selected the language: ${langName}. You MUST respond ONLY in ${langName}. If the language is Hindi, reply either in pure Hindi or clean conversational Hinglish.` },
            ...groqSessions[currentSessionId].filter(m => m.role !== 'system')
        ];

        // Robust models to try in case of decommissioned or unsupported model errors
        const modelsToTry = [
            process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
            "llama-3.1-8b-instant",
            "llama3-8b-8192",
            "gemma2-9b-it"
        ];

        let finalReply;
        let success = false;

        try {
            for (let i = 0; i < modelsToTry.length; i++) {
                const currentModel = modelsToTry[i];
                try {
                    console.log(`🤖 [Groq] Trying model: ${currentModel}...`);
                    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model: currentModel,
                            messages: apiMessages,
                            temperature: 0.7,
                            stream: false
                        })
                    });

                    if (!response.ok) {
                        const errBody = await response.text();
                        console.warn(`⚠️ [Groq] Model ${currentModel} failed with status ${response.status}: ${errBody}`);
                        // If it's a 400/404 error (invalid model), continue loop to try the next model
                        if (response.status === 400 || response.status === 404) {
                            continue;
                        }
                        throw new Error(`Groq API returned ${response.status}: ${errBody}`);
                    }

                    const data = await response.json();
                    if (data.choices && data.choices[0] && data.choices[0].message) {
                        finalReply = data.choices[0].message.content;
                        success = true;
                        // Push assistant reply to history
                        groqSessions[currentSessionId].push({ role: "assistant", content: finalReply });
                        break; // Exit loop on success
                    }
                } catch (err) {
                    console.error(`❌ [Groq] Call failed for ${currentModel}:`, err.message);
                    if (i === modelsToTry.length - 1) {
                        throw err; // Re-throw if it was the last model
                    }
                }
            }

            if (!success) {
                throw new Error("All Groq models failed to respond.");
            }
        } catch (err) {
            console.error("❌ Groq Call Failed entirely:", err);
            finalReply = "Sorry, I am experiencing a temporary technical glitch. Please try again or ask for our live agent.";
            // Remove last user message so we don't pollute the state on error
            groqSessions[currentSessionId].pop();
        }


        // Check if Gemini successfully gathered all details
        let bookingMatch = finalReply.match(/\[BOOKING_READY:\s*({.*?})\]/s);
        if (bookingMatch) {
            try {
                const details = JSON.parse(bookingMatch[1]);
                
                // Resiliently fetch keys to ensure phone and other parameters never fail even if AI uses slightly different casing
                const customerName = details.name || details.customerName || details.customer_name || 'Valued Customer';
                const customerPhone = details.phone || details.phone_number || details.phoneNumber || details.mobile || 'N/A';
                const customerIssue = details.issue || details.reason || 'General Inquiry';
                const appointmentDate = details.date || '';
                const appointmentTime = details.time || '';
                
                // Double Booking Check!
                const isBooked = await isSlotBooked(appointmentDate, appointmentTime);
                if (isBooked) {
                    console.log(`⚠️ Slot ${appointmentDate} ${appointmentTime} is ALREADY BOOKED! Triggering dynamic AI apology...`);
                    
                    // Apologize politely using the AI
                    groqSessions[currentSessionId].pop(); // remove last assistant message with secret tag
                    groqSessions[currentSessionId].push({
                        role: "system",
                        content: `SYSTEM WARNING: The slot ${appointmentDate} at ${appointmentTime} is already booked in the Google Calendar. You MUST apologize politely to the user in their exact language, explain that this specific slot is already taken, and ask them to choose another date or time.`
                    });

                    // Call Groq again to get a custom, translated apology
                    let apologyReply;
                    for (let i = 0; i < modelsToTry.length; i++) {
                        const currentModel = modelsToTry[i];
                        try {
                            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    model: currentModel,
                                    messages: groqSessions[currentSessionId],
                                    temperature: 0.7,
                                    stream: false
                                })
                            });

                            if (response.ok) {
                                const data = await response.json();
                                apologyReply = data.choices[0].message.content;
                                break;
                            }
                        } catch (e) {}
                    }

                    finalReply = apologyReply || "Sorry, this time slot is already booked. Could you please select another date or time?";
                    // Save apology to chat history
                    groqSessions[currentSessionId].push({ role: "assistant", content: finalReply });
                    // Nullify bookingMatch so we don't save to Sheets or show payment button
                    bookingMatch = null;
                } else {
                    // Remove the secret tag from the user-facing reply
                    finalReply = finalReply.replace(/\[BOOKING_READY:\s*({.*?})\]/s, '').trim();
                    
                    // Save lead to Google Sheets!
                    const currentDate = new Date().toISOString().split('T')[0];
                    console.log(`📊 [Sheets API] Resiliently saving phone: ${customerPhone} to Google Sheet...`);
                    await saveDataToSheet(currentDate, customerName, String(customerPhone), customerIssue, `${appointmentDate} ${appointmentTime}`, 'Pending');

                    // Book in Google Calendar!
                    if (process.env.GOOGLE_CALENDAR_ID) {
                        try {
                            const startDateTime = new Date(`${appointmentDate}T${appointmentTime}:00`);
                            const endDateTime = new Date(startDateTime.getTime() + 30 * 60 * 1000); // 30 mins duration
                            
                            await calendar.events.insert({
                                calendarId: process.env.GOOGLE_CALENDAR_ID,
                                requestBody: {
                                    summary: `📅 Appointment: ${customerName}`,
                                    description: `Issue: ${customerIssue}\nPhone: ${customerPhone}`,
                                    start: { dateTime: startDateTime.toISOString(), timeZone: 'Asia/Kolkata' },
                                    end: { dateTime: endDateTime.toISOString(), timeZone: 'Asia/Kolkata' }
                                }
                            });
                            console.log(`✅ [Calendar] Successfully booked slot for ${customerName}`);
                        } catch (calError) {
                            console.error("⚠️ [Calendar Error] Failed to book event:", calError.message);
                        }
                    }

                    // Render Payment Button
                    messages.push({
                        type: 'payload',
                        data: {
                            action: "RENDER_PAYMENT_BUTTON",
                            paymentData: { amount: 500, currency: 'INR', paymentUrl: 'https://rzp.io/l/demo', buttonText: "Pay & Book Now" }
                        }
                    });
                }
            } catch(e) {
                console.error("Failed to parse booking details:", e);
            }
        }

        messages.unshift({ type: 'text', text: finalReply });

        return res.json({
            reply: finalReply,
            messages: messages,
            intent: bookingMatch ? "Generate_Payment" : "Conversational"
        });

    } catch (error) {
        console.error("[Chat API Error]:", error);
        res.status(500).json({ error: "Failed to communicate with AI" });
    }
});

app.post('/whatsapp', async (req, res) => {
    const sender = req.body.From;
    const incomingMsg = req.body.Body || '';
    
    // Very simple language detection
    const lowerText = incomingMsg.toLowerCase();
    let lang = 'en'; // Default
    
    if (/[\u0900-\u097F]/.test(lowerText) || lowerText.match(/\b(namaste|hai|kya|kaise|booking|mujhe|appointment chahiye)\b/)) {
        lang = 'hi';
    } else if (lowerText.match(/\b(hola|buenos|dias|gracias|por favor|quiero|cita)\b/)) {
        lang = 'es';
    } else if (lowerText.match(/\b(bonjour|salut|merci|s'il vous plaît|je veux|rendez-vous)\b/)) {
        lang = 'fr';
    }

    const buyRegex = /\b(buy|purchase|price|kharidna|banwana|interest|agent|bot chahiye|cost)\b/i;
    if (buyRegex.test(lowerText)) {
        sendTelegramMessage(`🔥 *New WhatsApp Lead!*\nNumber: ${sender}\nUser asked: "${incomingMsg}"\n\n(Note: Direct reply via bot is supported for web widget. For WhatsApp, manually contact them on their number)`);
    }

    const pitches = {
        hi: "नमस्कार! 👋\n\nआपकी रुचि के लिए बहुत-बहुत धन्यवाद। हमारी यह *WhatsApp AI Chatbot* सर्विस अभी 'Under Maintenance / Demo Mode' में है。\n\nयह एक Premium Feature है। यदि आप अपने बिज़नेस के लिए ऐसा ही स्मार्ट AI चैटबॉट बनवाना चाहते हैं, तो कृपया हमारी टीम से संपर्क करें! 🚀💼\n\nयदि आप हमसे अपना कस्टम AI एजेंट बनवाते हैं, तो आपको WhatsApp इंटीग्रेशन और पेमेंट गेटवे जैसे सभी एडवांस फीचर 100% वर्किंग कंडीशन (Working Condition) में मिलेंगे।",
        en: "Hello! 👋\n\nThank you for your interest. Our *WhatsApp AI Chatbot* service is currently in 'Under Maintenance / Demo Mode'.\n\nThis is a Premium Feature. If you wish to build a similarly smart AI chatbot for your business, please contact our team! 🚀💼\n\nIf you get your custom AI agent built by us, you will receive all advanced features like WhatsApp integration and Payment Gateways in 100% Working Condition.",
        es: "¡Hola! 👋\n\nGracias por su interés. Nuestro servicio *WhatsApp AI Chatbot* se encuentra actualmente en 'Modo de demostración / Mantenimiento'.\n\nEsta es una función Premium. Si desea crear un chatbot de IA inteligente para su negocio, comuníquese con nuestro equipo. 🚀💼\n\nSi creamos su agente de IA personalizado, recibirá todas las funciones avanzadas, como la integración de WhatsApp y la pasarela de pago, en condiciones de funcionamiento del 100 %.",
        fr: "Bonjour ! 👋\n\nMerci de votre intérêt. Notre service *WhatsApp AI Chatbot* est actuellement en 'Mode Démo / Maintenance'.\n\nCeci est une fonctionnalité Premium. Si vous souhaitez créer un chatbot IA intelligent pour votre entreprise, veuillez contacter notre équipe ! 🚀💼\n\nSi vous faites construire votre agent IA personnalisé par nous, vous recevrez toutes les fonctionnalités avancées telles que l'intégration WhatsApp et la passerelle de paiement en condition 100% opérationnelle."
    };

    const replyText = pitches[lang] || pitches['en'];

    const twiml = `
        <Response>
            <Message>${replyText}</Message>
        </Response>
    `;

    res.set('Content-Type', 'text/xml');
    res.send(twiml);
});

async function checkAvailability(dateString) {
    const startTime = new Date(`${dateString}T10:00:00+05:30`);
    const endTime = new Date(`${dateString}T18:00:00+05:30`);
    const response = await calendar.events.list({ calendarId: CALENDAR_ID, timeMin: startTime.toISOString(), timeMax: endTime.toISOString(), singleEvents: true, orderBy: 'startTime' });
    const bookedEvents = response.data.items || [];
    const availableSlots = [];
    let currentSlot = new Date(startTime);

    while (currentSlot < endTime) {
        let slotEnd = new Date(currentSlot.getTime() + 60 * 60 * 1000); 
        const isConflict = bookedEvents.some(event => {
            const eventStart = new Date(event.start.dateTime || event.start.date);
            const eventEnd = new Date(event.end.dateTime || event.end.date);
            return (currentSlot < eventEnd && slotEnd > eventStart);
        });
        if (!isConflict) availableSlots.push(currentSlot.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
        currentSlot = slotEnd;
    }
    return availableSlots;
}

async function createCalendarEvent(customerName, customerPhone, dateTimeIso) {
    const startDateTime = new Date(dateTimeIso);
    const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);
    const event = {
        summary: `Appointment: ${customerName}`,
        description: `Customer Phone: ${customerPhone}`,
        start: { dateTime: startDateTime.toISOString(), timeZone: 'Asia/Kolkata' },
        end: { dateTime: endDateTime.toISOString(), timeZone: 'Asia/Kolkata' },
    };
    await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event });
}

app.post('/webhook', async (req, res) => {
    try {
        const intentName = req.body.queryResult?.intent?.displayName;
        const parameters = req.body.queryResult?.parameters || {};
        
        if (intentName === 'Check_Availability') {
            const requestedDate = parameters.date ? parameters.date.split('T')[0] : new Date().toISOString().split('T')[0];
            const availableSlots = await checkAvailability(requestedDate);
            return res.json({ fulfillmentMessages: [{ text: { text: ["Here are the available time slots for your requested date:"] } }, { payload: { action: "RENDER_TIME_SLOTS", date: requestedDate, slots: availableSlots } }] });
        }

        if (intentName === 'Capture_Details' || intentName === 'Generate_Payment') {
            const name = parameters.name || 'Unknown Customer';
            const phone = parameters.phone || 'N/A';
            const issue = parameters.issue || 'General Inquiry';
            const currentDate = new Date().toISOString().split('T')[0];
            await saveDataToSheet(currentDate, name, phone, issue, 'Pending Appointment', 'Pending');
            if (intentName === 'Capture_Details') return res.json({ fulfillmentText: "Thank you for providing your details!" });
        }

        if (intentName === 'Confirm_Booking') {
            const customerName = parameters.name || 'Valued Customer';
            const customerPhone = parameters.phone || 'N/A';
            const appointmentDateTime = parameters.dateTime;
            const issue = parameters.issue || 'N/A';
            const currentDate = new Date().toISOString().split('T')[0];

            if (!appointmentDateTime) return res.json({ fulfillmentText: "I could not find the exact appointment time. Please try again." });

            await createCalendarEvent(customerName, customerPhone, appointmentDateTime);
            await saveDataToSheet(currentDate, customerName, customerPhone, issue, new Date(appointmentDateTime).toLocaleString(), 'Paid');

            return res.json({ fulfillmentText: `Perfect! Your appointment for ${new Date(appointmentDateTime).toLocaleString()} has been confirmed and officially booked in our calendar.` });
        }

        if (intentName === 'Generate_Payment') {
            const currency = parameters.currency || 'INR'; 
            let paymentLinkUrl = 'https://rzp.io/l/demo'; // Mock link for safety in this refactor
            return res.json({
                fulfillmentMessages: [
                    { text: { text: ["Great! Your slot is tentatively reserved. Please complete your payment to finalize the booking."] } },
                    { payload: { action: "RENDER_PAYMENT_BUTTON", paymentData: { amount: 500, currency: currency, paymentUrl: paymentLinkUrl, buttonText: "Pay & Book Now" } } }
                ]
            });
        }

        return res.json({ fulfillmentText: "Webhook received successfully." });
    } catch (error) {
        return res.json({ fulfillmentText: "Sorry, there was an internal server error." });
    }
});

app.get('/setup', async (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return res.send("Error: TELEGRAM_BOT_TOKEN not found in .env");
    
    try {
        const http = require('http');
        const ngrokRes = await new Promise((resolve, reject) => {
            http.get('http://127.0.0.1:4040/api/tunnels', response => {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
                });
            }).on('error', reject);
        });

        if (ngrokRes && ngrokRes.tunnels && ngrokRes.tunnels.length > 0) {
            const publicUrl = ngrokRes.tunnels.find(t => t.public_url.startsWith('https')).public_url;
            const webhookUrl = `${publicUrl}/telegram-webhook`;
            
            https.get(`https://api.telegram.org/bot${token}/setWebhook?url=${webhookUrl}`, whRes => {
                res.send(`<h1>✅ Success!</h1><p>Telegram Webhook has been permanently linked to your current Ngrok URL: <b>${webhookUrl}</b></p><p>You can now chat from Telegram and it will appear on your website!</p>`);
            });
        } else {
            res.send("Ngrok tunnels found, but no HTTPS URL available.");
        }
    } catch (e) {
        res.send("<h1>⚠️ Error</h1><p>Could not find Ngrok running. Please make sure you have run <b>ngrok http 3000</b> in another terminal.</p>");
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log(`👉 To set/update Telegram Webhook, visit: http://localhost:${PORT}/setup`);
});
