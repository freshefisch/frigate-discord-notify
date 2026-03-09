import mqtt from 'mqtt';
import axios from 'axios';
import FormData from 'form-data';
import { DateTime } from 'luxon';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';

require("log-timestamp")(function() {
    const timestamp = DateTime.now();
    return `${timestamp.toString()} %s`;
});

const configPath = process.env.CONFIG_PATH || path.join(process.cwd(), 'config.yml');

if (!fs.existsSync(configPath)) {
    console.error(`[Fatal] Config file not found at ${configPath}`);
    process.exit(1);
}

const configStr = fs.readFileSync(configPath, 'utf8');
const config = yaml.load(configStr) as any;

const FRIGATE_URL = config.frigate.url;
const MQTT_BROKER = config.mqtt.broker;
const MQTT_USER = config.mqtt.username;
const MQTT_PASS = config.mqtt.password;
const MQTT_TOPIC = config.mqtt.topic || 'frigate/reviews';
const DISCORD_WEBHOOK_URL = config.discord.webhook_url;


const processedDetections = new Set<string>();

// --- Types ---
interface MQTTReview {
    type: 'new' | 'update' | 'end';
    before: Review;
    after: Review;
}

interface Review {
    id: string;
    camera: string;
    severity: string;
    data: {
        detections: string[];
    };
}

interface FrigateEvent {
    id: string;
    camera: string;
    label: string;
    top_score?: number;
    has_snapshot: boolean;
    data?: {
        top_score?: number;
        score?: number;
    };
}

// --- Helper: Fetch Image into Memory (Buffer) ---
// By returning a Buffer, keep the file in memory
async function fetchSnapshotBuffer(eventId: string, queryParams: string = ''): Promise<Buffer | null> {
    const url = `${FRIGATE_URL}/api/events/${eventId}/snapshot.jpg${queryParams}`;
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data);
    } catch (error) {
        console.error(`[Error] Failed to fetch snapshot for ${eventId}`);
        return null;
    }
}

// --- Helper: Send to Discord ---
async function sendToDiscord(event: FrigateEvent, confidence: string, croppedBuf: Buffer, fullBuf: Buffer) {
    const form = new FormData();
    
    // Construct the Discord Embed Payload
    const payload = {
        embeds: [{
            title: `🚨 Detection: ${event.label.toUpperCase()}`,
            color: 0xFF9900, // Orange color
            fields: [
                { name: 'Camera', value: event.camera, inline: true },
                { name: 'Confidence', value: confidence, inline: true },
                { name: 'Event ID', value: event.id, inline: true }
            ],
            // Use the "attachment://" protocol to link to the uploaded files
            image: { url: 'attachment://cropped.jpg' },
            thumbnail: { url: 'attachment://full.jpg' },
            timestamp: new Date().toISOString()
        }]
    };

    // Attach the JSON payload and the two buffers
    form.append('payload_json', JSON.stringify(payload));
    form.append('files[0]', croppedBuf, { filename: 'cropped.jpg' });
    form.append('files[1]', fullBuf, { filename: 'full.jpg' });

    try {
        await axios.post(DISCORD_WEBHOOK_URL, form, {
            headers: form.getHeaders()
        });
        console.log(`[Discord] Alert sent for event ${event.id}`);
    } catch (err) {
        console.error('[Error] Failed to send Discord webhook:', err);
    }
}

// --- MQTT Setup & Handling ---
console.log('Connecting to MQTT broker...');
const client = mqtt.connect(MQTT_BROKER, {
    username: MQTT_USER,
    password: MQTT_PASS,
});

client.on('connect', () => {
    console.log('Connected to MQTT!');
    client.subscribe(MQTT_TOPIC, (err) => {
        if (!err) {
            console.log(`Subscribed to topic: ${MQTT_TOPIC}`);
        } else {
            console.error('Failed to subscribe:', err);
        }
    });
});

client.on('message', async (topic, message) => {
    try {
        const payload = JSON.parse(message.toString()) as MQTTReview;
        const review = payload.after;
        
        if (!review || !review.data || !review.data.detections) return;

        // --- Handle Memory Cleanup on Event End ---
        if (payload.type === 'end') {
            console.log(`Event ended. Cleaning up memory for review ${review.id}`);
            // Remove all detection IDs associated with this finished review from the Set
            for (const detectionId of review.data.detections) {
                processedDetections.delete(detectionId);
            }
            return; 
        }

        // --- Process Active Alerts ---
        if (review.severity !== 'alert') return; 

        for (const detectionId of review.data.detections) {
            
            if (processedDetections.has(detectionId)) continue;

            const eventUrl = `${FRIGATE_URL}/api/events/${detectionId}`;
            const eventRes = await axios.get<FrigateEvent>(eventUrl);
            const event = eventRes.data;

            const score = event.top_score ?? event.data?.top_score ?? event.data?.score ?? 0;

            if (event.has_snapshot) {
                processedDetections.add(detectionId);

                const confidenceStr = (score * 100).toFixed(2) + '%';
                
                console.log(`--- Processing Alert: ${event.label} (${confidenceStr}) on ${event.camera} ---`);
                
                // Fetch the images into memory sequentially
                const croppedBuffer = await fetchSnapshotBuffer(event.id, '?bbox=1&crop=1');
                const fullBuffer = await fetchSnapshotBuffer(event.id, '?bbox=0');

                // If both downloads succeeded, send them to Discord
                if (croppedBuffer && fullBuffer) {
                    await sendToDiscord(event, confidenceStr, croppedBuffer, fullBuffer);
                } else {
                    console.log(`[Warn] Skipped Discord alert for ${event.id} due to missing image(s).`);
                }
            }
        }
    } catch (err) {
        console.error('Error processing MQTT message:', err);
    }
});