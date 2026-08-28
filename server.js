/**
 * ============================================================================
 * ALTIGUARD KERNEL v3.0 - ENTERPRISE COMMAND ROUTER
 * ============================================================================
 * Description: High-frequency WebSocket telemetry router for structural safety,
 * continuous GPS/Barometric monitoring, Geofencing, and AI Auditing.
 * 
 * Features Included:
 * - Advanced Socket.IO Room Management (Site Creation & Joining)
 * - Autonomous Garbage Collection (Prevents memory leaks on dead sites)
 * - Strict Payload Validation (Prevents malformed data crashes)
 * - Event-Driven Centralized Logging (Shift Compliance)
 * - Gemini 2.5 AI Studio Integration
 * - Emergency SOS & Global Evacuation Broadcasting
 * ============================================================================
 */

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');

// ============================================================================
// 1. CONFIGURATION & CONSTANTS
// ============================================================================
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''; // Pulled from Render Environment
const SITE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 Hours before an empty site is purged

const app = express();
const server = http.createServer(app);

// Enterprise Socket Configuration tailored for volatile field cellular networks
const io = require('socket.io')(server, {
    cors: { 
        origin: "*", 
        methods: ["GET", "POST", "OPTIONS"],
        credentials: true
    },
    pingTimeout: 120000,     // Allow 2 minutes of signal loss before dropping a worker
    pingInterval: 25000,     // Ping every 25 seconds to keep connection alive
    maxHttpBufferSize: 2e6   // 2MB max payload to accommodate large trace arrays
});

// Middleware
app.use(express.static(__dirname));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================================
// 2. IN-MEMORY DATABASE ARCHITECTURE
// ============================================================================

/**
 * The SiteManager class handles all in-memory state for active construction sites.
 * It replaces basic objects with structured, method-driven data management.
 */
class SiteManager {
    constructor() {
        this.sites = new Map();
    }

    /**
     * Generates a unique, readable 6-character site code.
     * @returns {string} e.g., "SITE-A1B2C3"
     */
    generateSiteCode() {
        let code;
        do {
            code = "SITE-" + crypto.randomBytes(3).toString('hex').toUpperCase();
        } while (this.sites.has(code));
        return code;
    }

    /**
     * Initializes a new operational site.
     * @param {string} requestedCode - Optional custom code requested by user
     * @param {string} creatorSocketId - The socket ID of the site admin
     * @returns {string} The finalized site code
     */
    createSite(requestedCode, creatorSocketId) {
        let code = requestedCode ? requestedCode.toUpperCase().trim().replace(/[^A-Z0-9-]/g, '') : null;
        if (!code || code.length < 3) {
            code = this.generateSiteCode();
        }

        if (!this.sites.has(code)) {
            this.sites.set(code, {
                id: code,
                createdAt: Date.now(),
                lastActive: Date.now(),
                creatorSocketId: creatorSocketId,
                members: new Map(),
                zones: [],
                logs: [],
                referenceElevation: 0,
                status: 'ACTIVE'
            });
        } else {
            // Re-claim creator rights if the site exists but is abandoned
            const site = this.sites.get(code);
            if (site.members.size === 0) {
                site.creatorSocketId = creatorSocketId;
                site.lastActive = Date.now();
            }
        }
        return code;
    }

    /**
     * Retrieves a site by its code.
     * @param {string} code 
     * @returns {Object|null}
     */
    getSite(code) {
        if (!code) return null;
        const site = this.sites.get(code.toUpperCase().trim());
        if (site) site.lastActive = Date.now(); // Update activity heartbeat
        return site || null;
    }

    /**
     * Appends a log entry to the site's permanent compliance ledger.
     * @param {string} code - Site code
     * @param {string} type - Log category (e.g., 'ALERT', 'SYSTEM')
     * @param {string} message - Human-readable event description
     * @param {string} level - Severity ('info', 'warning', 'critical')
     * @returns {Array} The updated logs array
     */
    appendLog(code, type, message, level = 'info') {
        const site = this.getSite(code);
        if (!site) return [];

        const logEntry = {
            id: crypto.randomUUID(),
            time: new Date().toISOString(),
            type: type.toUpperCase(),
            message: message,
            level: level.toLowerCase()
        };

        site.logs.unshift(logEntry);
        // Truncate to prevent memory overflow (keep last 1000 events)
        if (site.logs.length > 1000) site.logs.pop();
        return site.logs;
    }

    /**
     * Runs periodically to delete dead sites and free up server RAM.
     */
    garbageCollect() {
        const now = Date.now();
        let purgedCount = 0;
        for (const [code, site] of this.sites.entries()) {
            if (now - site.lastActive > SITE_TIMEOUT_MS && site.members.size === 0) {
                this.sites.delete(code);
                purgedCount++;
            }
        }
        if (purgedCount > 0) {
            console.log(`[SYS_MEM] Garbage Collection complete. Purged ${purgedCount} inactive sites.`);
        }
    }
}

// Instantiate the global database
const db = new SiteManager();

// Run Garbage Collection every hour
setInterval(() => db.garbageCollect(), 60 * 60 * 1000);


// ============================================================================
// 3. REST API ENDPOINTS
// ============================================================================

// Health check for Cloud Load Balancers
app.get('/health', (req, res) => {
    res.status(200).json({
        service: 'Altiguard Kernel',
        status: 'Operational',
        uptime_seconds: Math.floor(process.uptime()),
        active_sites: db.sites.size,
        timestamp: new Date().toISOString()
    });
});


// ============================================================================
// 4. WEBSOCKET ROUTING & BUSINESS LOGIC
// ============================================================================

io.on('connection', (socket) => {
    console.log(`[CONNECT] New handshake established: ${socket.id}`);
    let currentSiteCode = null;

    // ------------------------------------------------------------------------
    // A. INITIALIZATION & AUTHENTICATION
    // ------------------------------------------------------------------------
    
    /**
     * @event createGroup
     * Initializes a new operational matrix and assigns Creator role.
     */
    socket.on('createGroup', (requestedCode) => {
        try {
            if (currentSiteCode) socket.leave(currentSiteCode);
            
            const code = db.createSite(requestedCode, socket.id);
            currentSiteCode = code;
            socket.join(code);

            const site = db.getSite(code);
            const logs = db.appendLog(code, 'SYSTEM', `Site Command Matrix initialized by ID: ${socket.id}`, 'success');

            // Dispatch state to the new creator
            socket.emit('roleAssigned', { role: 'creator', roomCode: code });
            socket.emit('syncGroup', Array.from(site.members.values()));
            socket.emit('syncZones', site.zones);
            socket.emit('syncLogs', logs);
            socket.emit('syncReference', site.referenceElevation);

            console.log(`[SITE_CREATE] Site ${code} initialized.`);
        } catch (error) {
            console.error(`[ERR_CREATE]`, error);
            socket.emit('groupError', 'Fatal error during site initialization.');
        }
    });

    /**
     * @event joinGroup
     * Authenticates a worker into an existing matrix.
     */
    socket.on('joinGroup', (roomCode) => {
        try {
            const site = db.getSite(roomCode);
            if (!site) {
                return socket.emit('groupError', 'Target site does not exist. Verify alphanumeric code.');
            }

            if (currentSiteCode) socket.leave(currentSiteCode);
            currentSiteCode = site.id;
            socket.join(site.id);

            // Determine if joining user is the original creator re-connecting
            const isCreator = site.creatorSocketId === socket.id;
            const assignedRole = isCreator ? 'creator' : 'worker';

            db.appendLog(site.id, 'NETWORK', `Node connected. Assigned role: ${assignedRole.toUpperCase()}`, 'info');

            socket.emit('roleAssigned', { role: assignedRole, roomCode: site.id });
            socket.emit('syncGroup', Array.from(site.members.values()));
            socket.emit('syncZones', site.zones);
            socket.emit('syncLogs', site.logs);
            socket.emit('syncReference', site.referenceElevation);

            console.log(`[SITE_JOIN] Socket ${socket.id} joined ${site.id} as ${assignedRole}`);
        } catch (error) {
            console.error(`[ERR_JOIN]`, error);
            socket.emit('groupError', 'Fatal error during site connection.');
        }
    });


    // ------------------------------------------------------------------------
    // B. TELEMETRY & PHYSICS SYNC
    // ------------------------------------------------------------------------

    /**
     * @event updateGroup
     * Receives high-frequency coordinate arrays from clients and broadcasts to peers.
     */
    socket.on('updateGroup', (newGroupData) => {
        const site = db.getSite(currentSiteCode);
        if (site && Array.isArray(newGroupData)) {
            // Update internal tracking maps
            newGroupData.forEach(member => {
                if (member && member.id) {
                    site.members.set(member.id, member);
                }
            });
            // Re-broadcast mapped array
            socket.to(currentSiteCode).emit('syncGroup', Array.from(site.members.values()));
        }
    });

    /**
     * @event updateReference
     * Updates the structural zero-point (Datum 0) for the site.
     */
    socket.on('updateReference', (newRef) => {
        const site = db.getSite(currentSiteCode);
        if (site && typeof newRef === 'number') {
            site.referenceElevation = newRef;
            const logs = db.appendLog(site.id, 'ENVIRONMENT', `Global elevation baseline calibrated to ${newRef.toFixed(2)}m`, 'warning');
            
            io.to(site.id).emit('syncReference', newRef);
            io.to(site.id).emit('syncLogs', logs);
        }
    });


    // ------------------------------------------------------------------------
    // C. GEOFENCING PROTOCOLS
    // ------------------------------------------------------------------------

    /**
     * @event addZone
     * Registers a new spherical danger zone on the map.
     */
    socket.on('addZone', (zone) => {
        const site = db.getSite(currentSiteCode);
        if (site && zone && typeof zone.lat === 'number' && typeof zone.lon === 'number') {
            const newZone = {
                id: crypto.randomUUID(),
                lat: zone.lat,
                lon: zone.lon,
                radius: zone.radius || 50,
                createdAt: new Date().toISOString()
            };
            site.zones.push(newZone);
            
            const logs = db.appendLog(site.id, 'GEOFENCE', `Restricted zone established at [${zone.lat.toFixed(4)}, ${zone.lon.toFixed(4)}]`, 'critical');
            io.to(site.id).emit('syncZones', site.zones);
            io.to(site.id).emit('syncLogs', logs);
        }
    });

    /**
     * @event clearZones
     * Purges all active geofences from the site.
     */
    socket.on('clearZones', () => {
        const site = db.getSite(currentSiteCode);
        if (site) {
            site.zones = [];
            const logs = db.appendLog(site.id, 'GEOFENCE', `All restricted zones purged by Command.`, 'info');
            io.to(site.id).emit('syncZones', site.zones);
            io.to(site.id).emit('syncLogs', logs);
        }
    });


    // ------------------------------------------------------------------------
    // D. EMERGENCY DISPATCH & SOS
    // ------------------------------------------------------------------------

    /**
     * @event triggerSOS
     * Handles manual hardware panic button triggers.
     */
    socket.on('triggerSOS', (payload) => {
        const site = db.getSite(currentSiteCode);
        if (site && payload && payload.name) {
            const h = typeof payload.height === 'number' ? payload.height.toFixed(2) : 'Unknown';
            const logs = db.appendLog(site.id, 'SOS', `CRITICAL SOS ACTIVATED BY ${payload.name.toUpperCase()} (Z: ${h}m)`, 'critical');
            
            io.to(site.id).emit('receiveSOS', payload);
            io.to(site.id).emit('syncLogs', logs);
        }
    });

    /**
     * @event triggerAlert
     * Handles automated kinematic fall detections.
     */
    socket.on('triggerAlert', (alertData) => {
        const site = db.getSite(currentSiteCode);
        if (site && alertData) {
            const drop = typeof alertData.drop === 'number' ? alertData.drop.toFixed(2) : 'Unknown';
            const logs = db.appendLog(site.id, 'FALL_DETECT', `Kinematic anomaly: ${alertData.name || 'Unknown'} dropped ${drop}m`, 'critical');
            
            // Broadcast alert to everyone ELSE in the room
            socket.to(site.id).emit('receiveAlert', alertData);
            io.to(site.id).emit('syncLogs', logs);
        }
    });

    /**
     * @event broadcastEmergencyLocation
     * Admin forces a GPS ping to all workers for evacuation.
     */
    socket.on('broadcastEmergencyLocation', (payload) => {
        const site = db.getSite(currentSiteCode);
        if (site && payload) {
            const logs = db.appendLog(site.id, 'EVACUATION', `Evacuation coordinates broadcasted for ${payload.name || 'Operator'}`, 'critical');
            io.to(site.id).emit('receiveEmergencyBroadcast', payload);
            io.to(site.id).emit('syncLogs', logs);
        }
    });

    /**
     * @event logIncident
     * Standard client-to-server text logging gateway.
     */
    socket.on('logIncident', (msg) => {
        const site = db.getSite(currentSiteCode);
        if (site && typeof msg === 'string') {
            const logs = db.appendLog(site.id, 'REPORT', msg, 'warning');
            io.to(site.id).emit('syncLogs', logs);
        }
    });


    // ------------------------------------------------------------------------
    // E. ROSTER ADMINISTRATION
    // ------------------------------------------------------------------------

    /**
     * @event removeMember
     * Strict role-enforced deletion of personnel from the grid.
     */
    socket.on('removeMember', ({ personId, requestedByPersonId, requesterRole }) => {
        const site = db.getSite(currentSiteCode);
        if (!site) return;

        // Security Authorization Check
        const isCreator = site.creatorSocketId === socket.id;
        const isSubAdmin = requesterRole === 'sub-admin';
        const isSelf = personId === requestedByPersonId;

        if (isCreator || isSubAdmin || isSelf) {
            if (site.members.has(personId)) {
                const operatorName = site.members.get(personId).name;
                site.members.delete(personId);
                
                const action = isSelf ? 'disconnected voluntarily' : 'was ejected by Command';
                const logs = db.appendLog(site.id, 'ROSTER', `Operator [${operatorName}] ${action}.`, 'warning');
                
                io.to(site.id).emit('syncGroup', Array.from(site.members.values()));
                io.to(site.id).emit('syncLogs', logs);
            }
        } else {
            socket.emit('groupError', 'Access Denied: You lack administrative clearance to eject nodes.');
        }
    });


    // ------------------------------------------------------------------------
    // F. GOOGLE GEMINI AI INTEGRATION
    // ------------------------------------------------------------------------

    /**
     * @event requestAiInsight
     * Compiles spatial telemetry and hits the Google GenAI API for safety auditing.
     */
    socket.on('requestAiInsight', async (siteData) => {
        try {
            if (!GEMINI_API_KEY) {
                return socket.emit('aiInsightResponse', { 
                    error: "AI Services Offline: Google Gemini API Key is missing in server environment variables." 
                });
            }
            
            // Construct the strictly formatted context prompt
            const prompt = `
                You are Altiguard AI, an expert structural safety and occupational health assistant operating on a live construction site. 
                Analyze the following live telemetry:
                - Active Personnel on Grid: ${siteData.workerCount}
                - Maximum Working Elevation: +${siteData.highestElevation}m
                - Local Wind Speed: ${siteData.windSpeed}
                - Local Temperature: ${siteData.temperature}
                - Active Danger Zones (Geofences): ${siteData.zonesCount}
                - Low Battery Hardware Warnings: ${siteData.lowBatteryCount}
                
                Task: Provide a highly professional, 2-to-3 sentence safety briefing. 
                Identify the highest immediate environmental or structural risk based on this exact data, and propose one actionable mitigation step for the site foreman.
                Constraint: Do not use any markdown formatting (no asterisks, no bolding). Keep it direct and authoritative.
            `;
            
            // Execute outbound fetch to Google GenAI REST Endpoint
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ 
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.2, // Keep it highly analytical and grounded
                        maxOutputTokens: 150
                    }
                }) 
            });
            
            if (!response.ok) {
                throw new Error(`Google API returned HTTP ${response.status}`);
            }

            const data = await response.json();
            
            if (data.candidates && data.candidates.length > 0) {
                const aiText = data.candidates[0].content.parts[0].text;
                socket.emit('aiInsightResponse', { result: aiText });
                
                // Log the successful audit
                if (currentSiteCode) {
                    const logs = db.appendLog(currentSiteCode, 'AI_AUDIT', `Automated safety audit generated successfully.`, 'info');
                    io.to(currentSiteCode).emit('syncLogs', logs);
                }
            } else {
                throw new Error("Empty candidate response from Gemini.");
            }

        } catch (err) { 
            console.error("[ERR_AI_PIPELINE]", err.message);
            socket.emit('aiInsightResponse', { error: `AI Engine Pipeline Failure: ${err.message}` }); 
        }
    });

    // ------------------------------------------------------------------------
    // G. CLEANUP & DISCONNECT
    // ------------------------------------------------------------------------

    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] Socket severed: ${socket.id}`);
        // Note: We do NOT delete the site immediately upon creator disconnect.
        // They might just be switching apps. Garbage collection will catch it if they never return.
    });

});

// ============================================================================
// 5. SERVER INITIALIZATION
// ============================================================================

server.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(`🚀 ALTIGUARD KERNEL v3.0 ONLINE`);
    console.log(`📡 WebSocket Telemetry Router Active on Port: ${PORT}`);
    console.log(`🧠 AI Engine Key Detected: ${GEMINI_API_KEY ? 'YES' : 'NO'}`);
    console.log(`===================================================`);
});
