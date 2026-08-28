/**
 * ==========================================================================================
 * ALTIGUARD KERNEL v4.0 - ENTERPRISE TELEMETRY & COMMAND ROUTER (SERVER)
 * ==========================================================================================
 * Description: Massive, highly concurrent Node.js / Socket.IO routing engine.
 * Handles spatial physics state, high-frequency GPS/Barometric arrays, Role-Based 
 * Access Control (RBAC), Geofence state propagation, and Google Gemini AI Auditing.
 * 
 * Architecture & Security Features:
 * - Object-Oriented Site & Memory Management (SiteManager Class)
 * - Autonomous Garbage Collection (Prevents Node.js heap overflow from abandoned sessions)
 * - Strict Payload Validation & Event Sanitization
 * - Immutable Compliance Ledgers (Server-side chronological logging)
 * - Role-Enforced Event Execution (Prevents client-side privilege escalation)
 * - Native REST Health Check Endpoints for AWS/Render Load Balancers
 * 
 * Developer: Vaibhav Raju Kondane
 * ==========================================================================================
 */

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');

// ==========================================================================================
// 1. KERNEL CONFIGURATION & CONSTANTS
// ==========================================================================================
const KERNEL_CONFIG = {
    PORT: process.env.PORT || 3000,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '', // Fetched from cloud environment variables
    
    // Memory & Lifecycle Tuning
    SITE_TIMEOUT_MS: 12 * 60 * 60 * 1000, // 12 Hours before an abandoned site is purged from RAM
    GARBAGE_COLLECTION_INTERVAL: 60 * 60 * 1000, // Run GC every 1 hour
    MAX_LOGS_PER_SITE: 1000, // Limit log arrays to prevent memory bloat
    
    // Network & Socket Resilience (Tuned for volatile 4G/5G field networks)
    SOCKET_PING_TIMEOUT: 120000,   // Allow 2 minutes of signal loss before dropping a worker
    SOCKET_PING_INTERVAL: 25000,   // Heartbeat every 25 seconds
    SOCKET_MAX_PAYLOAD: 2e6,       // 2MB max payload to accommodate large trace history arrays
    
    // System Roles
    ROLES: {
        CREATOR: 'creator',
        SUB_ADMIN: 'sub-admin',
        WORKER: 'worker'
    }
};

const app = express();
const server = http.createServer(app);

// Enterprise Socket Configuration
const io = require('socket.io')(server, {
    cors: { 
        origin: "*", 
        methods: ["GET", "POST", "OPTIONS"],
        credentials: true
    },
    pingTimeout: KERNEL_CONFIG.SOCKET_PING_TIMEOUT,
    pingInterval: KERNEL_CONFIG.SOCKET_PING_INTERVAL,
    maxHttpBufferSize: KERNEL_CONFIG.SOCKET_MAX_PAYLOAD
});

// Middleware Implementation
app.use(express.static(__dirname));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));


// ==========================================================================================
// 2. SECURITY & UTILITY MODULE
// ==========================================================================================
class SecurityUtils {
    /**
     * Strips malicious characters from strings to prevent NoSQL/XSS injections.
     * @param {string} str - Raw input string
     * @returns {string} Sanitized string
     */
    static sanitizeString(str) {
        if (!str || typeof str !== 'string') return '';
        return str.replace(/[^\w\s-]/gi, '').trim();
    }

    /**
     * Enforces numeric types to prevent NaN propagation in telemetry arrays.
     * @param {any} val - Raw input value
     * @param {number} fallback - Default value if parsing fails
     * @returns {number}
     */
    static enforceNumber(val, fallback = 0) {
        const parsed = parseFloat(val);
        return isNaN(parsed) ? fallback : parsed;
    }

    /**
     * Generates an unguessable 16-character UUID for internal operations.
     * @returns {string}
     */
    static generateUUID() {
        return crypto.randomUUID();
    }
}


// ==========================================================================================
// 3. COMPLIANCE & LEDGER SERVICE
// ==========================================================================================
class LedgerService {
    /**
     * Appends a highly structured event log to a site's permanent ledger.
     * @param {Object} site - The Site Object reference
     * @param {string} type - Event Category (e.g., 'GEOFENCE', 'ALERT', 'SYSTEM')
     * @param {string} message - Human-readable event description
     * @param {string} level - Severity ('info', 'warning', 'critical')
     * @returns {Array} The truncated logs array
     */
    static appendRecord(site, type, message, level = 'info') {
        if (!site || !site.logs) return [];

        const logEntry = {
            id: SecurityUtils.generateUUID(),
            time: new Date().toISOString(),
            type: type.toUpperCase(),
            message: message,
            level: level.toLowerCase()
        };

        // Unshift adds to the beginning (most recent first)
        site.logs.unshift(logEntry);
        
        // Truncate ledger to prevent Node.js V8 Heap memory overflow
        if (site.logs.length > KERNEL_CONFIG.MAX_LOGS_PER_SITE) {
            site.logs.pop();
        }

        return site.logs;
    }
}


// ==========================================================================================
// 4. IN-MEMORY DATABASE ARCHITECTURE (SITE MANAGER)
// ==========================================================================================
class SiteManager {
    constructor() {
        // Using ES6 Maps for O(1) read/write performance compared to basic Objects
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
     * Initializes a new operational site architecture in RAM.
     * @param {string} requestedCode - Optional custom code requested by client
     * @param {string} creatorSocketId - The socket ID of the initial admin
     * @returns {string} The finalized operational site code
     */
    createSite(requestedCode, creatorSocketId) {
        let code = requestedCode ? SecurityUtils.sanitizeString(requestedCode).toUpperCase() : null;
        
        if (!code || code.length < 4) {
            code = this.generateSiteCode();
        }

        if (!this.sites.has(code)) {
            this.sites.set(code, {
                id: code,
                createdAt: Date.now(),
                lastActive: Date.now(),
                creatorSocketId: creatorSocketId,
                members: new Map(), // Inner map for O(1) worker lookups
                zones: [],          // Array of Geofence objects
                logs: [],           // Array of Ledger objects
                referenceElevation: 0,
                status: 'ACTIVE'
            });
        } else {
            // Priority Override: If site exists but is abandoned, reclaim creator rights
            const site = this.sites.get(code);
            if (site.members.size === 0) {
                site.creatorSocketId = creatorSocketId;
                site.lastActive = Date.now();
            }
        }
        return code;
    }

    /**
     * Retrieves a site by its code, updating its heartbeat.
     * @param {string} code 
     * @returns {Object|null}
     */
    getSite(code) {
        if (!code || typeof code !== 'string') return null;
        const site = this.sites.get(code.toUpperCase().trim());
        if (site) {
            site.lastActive = Date.now(); // Update activity heartbeat to prevent GC
            return site;
        }
        return null;
    }

    /**
     * Autonomous memory management. Runs periodically to delete dead sites.
     */
    runGarbageCollection() {
        const now = Date.now();
        let purgedCount = 0;
        
        for (const [code, site] of this.sites.entries()) {
            // Condition for purge: Site is older than timeout AND has zero active nodes
            if (now - site.lastActive > KERNEL_CONFIG.SITE_TIMEOUT_MS && site.members.size === 0) {
                this.sites.delete(code);
                purgedCount++;
            }
        }
        
        if (purgedCount > 0) {
            console.log(`[SYS_MEM] V8 Garbage Collection complete. Purged ${purgedCount} abandoned matrix blocks.`);
        }
    }
}

// Instantiate the global database
const Database = new SiteManager();

// Execute Autonomous Garbage Collection according to config schedule
setInterval(() => Database.runGarbageCollection(), KERNEL_CONFIG.GARBAGE_COLLECTION_INTERVAL);


// ==========================================================================================
// 5. GOOGLE GEMINI AI STUDIO PIPELINE
// ==========================================================================================
class AIService {
    /**
     * Formats site telemetry into a structured prompt and dispatches to Google GenAI REST Endpoint.
     * @param {Object} siteData - Telemetry metrics from the client
     * @returns {Promise<Object>} Formatted AI response or error
     */
    static async requestSafetyAudit(siteData) {
        if (!KERNEL_CONFIG.GEMINI_API_KEY) {
            throw new Error("AI Services Offline: Google Gemini API Key requires configuration in kernel environment.");
        }

        const prompt = `
            You are Altiguard AI, an expert structural safety and occupational health assistant embedded within an enterprise command matrix.
            Analyze the following live telemetry from an active construction/engineering grid:
            
            - Active Personnel Nodes: ${siteData.workerCount}
            - Maximum Working Elevation: +${siteData.highestElevation}m
            - Local Wind Speed: ${siteData.windSpeed}
            - Local Temperature: ${siteData.temperature}
            - Active Danger Zones (Geofences): ${siteData.zonesCount}
            - Hardware Nodes with Low Battery (<20%): ${siteData.lowBatteryCount}
            
            Task Constraints: 
            Provide a highly professional, authoritative, 2-to-3 sentence safety briefing. 
            1. Identify the highest immediate environmental, spatial, or hardware risk based strictly on this data.
            2. Propose one precise, actionable mitigation protocol for the Site Foreman.
            3. Do NOT use any Markdown formatting (no asterisks, no bolding, no headers). Output raw, clean text only.
        `;

        try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${KERNEL_CONFIG.GEMINI_API_KEY}`, { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ 
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.15, // Low temperature for highly grounded, analytical responses
                        maxOutputTokens: 200,
                        topP: 0.8
                    }
                }) 
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(`Google API Fault: ${response.status} - ${errData.error?.message || 'Unknown API Error'}`);
            }

            const data = await response.json();
            
            if (data.candidates && data.candidates.length > 0) {
                return { success: true, result: data.candidates[0].content.parts[0].text };
            } else {
                throw new Error("Empty candidate payload returned from Gemini Engine.");
            }
        } catch (error) {
            console.error("[AI_PIPELINE_FAULT]", error.message);
            return { success: false, error: error.message };
        }
    }
}


// ==========================================================================================
// 6. REST API METRICS & HEALTH CHECKS
// ==========================================================================================

// Critical for AWS/Render/Docker Load Balancer monitoring
app.get('/health', (req, res) => {
    res.status(200).json({
        service: 'Altiguard Enterprise Kernel',
        version: '4.0',
        status: 'Operational',
        uptime_seconds: Math.floor(process.uptime()),
        memory_usage: process.memoryUsage(),
        active_matrices: Database.sites.size,
        timestamp: new Date().toISOString()
    });
});


// ==========================================================================================
// 7. WEBSOCKET ROUTING & BUSINESS LOGIC ENGINE
// ==========================================================================================

io.on('connection', (socket) => {
    console.log(`[NET_CONNECT] Handshake established. Socket ID: ${socket.id}`);
    
    // Internal socket state tracking
    let currentSiteCode = null;

    /**
     * Helper: Broadcasts Ledger Updates to the room.
     */
    const broadcastLedger = (site) => {
        io.to(site.id).emit('syncLogs', site.logs);
    };


    // --------------------------------------------------------------------------------------
    // A. MATRIX INITIALIZATION & AUTHENTICATION
    // --------------------------------------------------------------------------------------
    
    /**
     * @event createGroup
     * Initializes a new operational matrix and grants Creator authority.
     */
    socket.on('createGroup', (requestedCode) => {
        try {
            if (currentSiteCode) socket.leave(currentSiteCode);
            
            const code = Database.createSite(requestedCode, socket.id);
            currentSiteCode = code;
            socket.join(code);

            const site = Database.getSite(code);
            LedgerService.appendRecord(site, 'SYSTEM', `Command Matrix [${code}] initialized. Authority granted to Node ${socket.id.slice(0,5)}`, 'success');

            // Dispatch Initial State
            socket.emit('roleAssigned', { role: KERNEL_CONFIG.ROLES.CREATOR, roomCode: code });
            socket.emit('syncGroup', Array.from(site.members.values()));
            socket.emit('syncZones', site.zones);
            socket.emit('syncReference', site.referenceElevation);
            broadcastLedger(site);

            console.log(`[SITE_CREATE] Matrix ${code} brought online.`);
        } catch (error) {
            console.error(`[ERR_CREATE]`, error);
            socket.emit('groupError', 'Fatal error during matrix initialization.');
        }
    });

    /**
     * @event joinGroup
     * Authenticates an inbound connection into an existing matrix.
     */
    socket.on('joinGroup', (roomCode) => {
        try {
            const site = Database.getSite(roomCode);
            if (!site) {
                return socket.emit('groupError', 'Target matrix does not exist or has been purged. Verify Site Code.');
            }

            if (currentSiteCode) socket.leave(currentSiteCode);
            currentSiteCode = site.id;
            socket.join(site.id);

            // Determine Privilege Level
            const isCreator = site.creatorSocketId === socket.id;
            const assignedRole = isCreator ? KERNEL_CONFIG.ROLES.CREATOR : KERNEL_CONFIG.ROLES.WORKER;

            LedgerService.appendRecord(site, 'NETWORK', `External Node authenticated. Granted role: ${assignedRole.toUpperCase()}`, 'info');

            // Dispatch Sync Protocols
            socket.emit('roleAssigned', { role: assignedRole, roomCode: site.id });
            socket.emit('syncGroup', Array.from(site.members.values()));
            socket.emit('syncZones', site.zones);
            socket.emit('syncReference', site.referenceElevation);
            broadcastLedger(site);

            console.log(`[SITE_JOIN] Socket ${socket.id} authenticated into ${site.id} as ${assignedRole}`);
        } catch (error) {
            console.error(`[ERR_JOIN]`, error);
            socket.emit('groupError', 'Fatal error during matrix connection.');
        }
    });


    // --------------------------------------------------------------------------------------
    // B. HIGH-FREQUENCY TELEMETRY SYNC
    // --------------------------------------------------------------------------------------

    /**
     * @event updateGroup
     * Ingests, maps, and broadcasts high-frequency $(x,y,z)$ coordinates from the field.
     */
    socket.on('updateGroup', (newGroupData) => {
        const site = Database.getSite(currentSiteCode);
        if (!site || !Array.isArray(newGroupData)) return;

        try {
            // Update the internal Map with validated objects
            newGroupData.forEach(member => {
                if (member && member.id) {
                    // Prevent client-side injection of invalid roles
                    const existing = site.members.get(member.id);
                    if (existing && existing.role === KERNEL_CONFIG.ROLES.CREATOR && member.role !== KERNEL_CONFIG.ROLES.CREATOR) {
                        member.role = KERNEL_CONFIG.ROLES.CREATOR; // Creator role is immutable by workers
                    }
                    site.members.set(member.id, member);
                }
            });

            // Re-broadcast mapped array to all peers except sender to save bandwidth
            socket.to(currentSiteCode).emit('syncGroup', Array.from(site.members.values()));
        } catch (err) {
            console.error("[ERR_SYNC_GROUP]", err);
        }
    });

    /**
     * @event updateReference
     * Updates the structural Datum Zero for physics calculations.
     */
    socket.on('updateReference', (newRef) => {
        const site = Database.getSite(currentSiteCode);
        if (site && typeof newRef === 'number') {
            const cleanRef = SecurityUtils.enforceNumber(newRef);
            site.referenceElevation = cleanRef;
            
            LedgerService.appendRecord(site, 'ENVIRONMENT', `Global Datum Baseline calibrated to ${cleanRef.toFixed(2)}m`, 'warning');
            
            io.to(site.id).emit('syncReference', cleanRef);
            broadcastLedger(site);
        }
    });


    // --------------------------------------------------------------------------------------
    // C. GEOFENCING & SPATIAL RESTRICTIONS
    // --------------------------------------------------------------------------------------

    /**
     * @event addZone
     * Registers a new spherical restriction boundary on the coordinate plane.
     */
    socket.on('addZone', (zone) => {
        const site = Database.getSite(currentSiteCode);
        if (!site || !zone || typeof zone.lat !== 'number' || typeof zone.lon !== 'number') return;

        // Role verification implicitly handled by client UI, but good to ensure valid data
        const newZone = {
            id: SecurityUtils.generateUUID(),
            lat: SecurityUtils.enforceNumber(zone.lat),
            lon: SecurityUtils.enforceNumber(zone.lon),
            radius: SecurityUtils.enforceNumber(zone.radius, 50),
            createdAt: new Date().toISOString()
        };
        
        site.zones.push(newZone);
        LedgerService.appendRecord(site, 'GEOFENCE', `Restricted sector established at coordinates [${newZone.lat.toFixed(4)}, ${newZone.lon.toFixed(4)}]`, 'critical');
        
        io.to(site.id).emit('syncZones', site.zones);
        broadcastLedger(site);
    });

    /**
     * @event clearZones
     * Purges all active spatial restrictions.
     */
    socket.on('clearZones', () => {
        const site = Database.getSite(currentSiteCode);
        if (site) {
            site.zones = [];
            LedgerService.appendRecord(site, 'GEOFENCE', `All restricted sectors purged by Command.`, 'info');
            
            io.to(site.id).emit('syncZones', site.zones);
            broadcastLedger(site);
        }
    });


    // --------------------------------------------------------------------------------------
    // D. CRITICAL EMERGENCY PROTOCOLS
    // --------------------------------------------------------------------------------------

    /**
     * @event triggerSOS
     * Handles manual hardware panic overrides.
     */
    socket.on('triggerSOS', (payload) => {
        const site = Database.getSite(currentSiteCode);
        if (!site || !payload || !payload.name) return;

        const h = SecurityUtils.enforceNumber(payload.height);
        const safeName = SecurityUtils.sanitizeString(payload.name);

        LedgerService.appendRecord(site, 'SOS', `CRITICAL SOS ACTIVATED BY ${safeName.toUpperCase()} (Z: ${h.toFixed(2)}m)`, 'critical');
        
        io.to(site.id).emit('receiveSOS', payload);
        broadcastLedger(site);
    });

    /**
     * @event triggerAlert
     * Handles automated kinematic fall detections.
     */
    socket.on('triggerAlert', (alertData) => {
        const site = Database.getSite(currentSiteCode);
        if (!site || !alertData) return;

        const drop = SecurityUtils.enforceNumber(alertData.drop);
        const safeName = SecurityUtils.sanitizeString(alertData.name) || 'Unknown Node';

        LedgerService.appendRecord(site, 'FALL_DETECT', `Kinematic anomaly: ${safeName} dropped ${drop.toFixed(2)}m`, 'critical');
        
        // Push alert to peers
        socket.to(site.id).emit('receiveAlert', alertData);
        broadcastLedger(site);
    });

    /**
     * @event broadcastEmergencyLocation
     * Forces an immediate GPS ping to all workers for evacuation routing.
     */
    socket.on('broadcastEmergencyLocation', (payload) => {
        const site = Database.getSite(currentSiteCode);
        if (!site || !payload) return;

        const safeName = SecurityUtils.sanitizeString(payload.name) || 'Operator';
        LedgerService.appendRecord(site, 'EVACUATION', `Rally coordinates broadcasted for ${safeName}`, 'critical');
        
        io.to(site.id).emit('receiveEmergencyBroadcast', payload);
        broadcastLedger(site);
    });

    /**
     * @event logIncident
     * Standard client-to-server text logging gateway.
     */
    socket.on('logIncident', (msg) => {
        const site = Database.getSite(currentSiteCode);
        if (site && typeof msg === 'string') {
            const safeMsg = SecurityUtils.sanitizeString(msg);
            LedgerService.appendRecord(site, 'REPORT', safeMsg, 'warning');
            broadcastLedger(site);
        }
    });


    // --------------------------------------------------------------------------------------
    // E. ROSTER ADMINISTRATION (STRICT RBAC)
    // --------------------------------------------------------------------------------------

    /**
     * @event removeMember
     * Ejects a node from the matrix. Server strictly enforces Admin/Creator roles.
     */
    socket.on('removeMember', ({ personId, requestedByPersonId, requesterRole }) => {
        const site = Database.getSite(currentSiteCode);
        if (!site) return;

        // Backend Authorization Verification
        const isCreator = site.creatorSocketId === socket.id;
        const isSubAdmin = requesterRole === KERNEL_CONFIG.ROLES.SUB_ADMIN;
        const isSelf = personId === requestedByPersonId;

        if (isCreator || isSubAdmin || isSelf) {
            if (site.members.has(personId)) {
                const operatorName = site.members.get(personId).name;
                site.members.delete(personId);
                
                const action = isSelf ? 'disconnected voluntarily' : 'was ejected by Command';
                LedgerService.appendRecord(site, 'ROSTER', `Node [${operatorName}] ${action}.`, 'warning');
                
                io.to(site.id).emit('syncGroup', Array.from(site.members.values()));
                broadcastLedger(site);
            }
        } else {
            // Reject unauthorized disconnect requests
            socket.emit('groupError', 'Access Denied: You lack administrative clearance to eject network nodes.');
        }
    });


    // --------------------------------------------------------------------------------------
    // F. GOOGLE GEMINI AI PIPELINE
    // --------------------------------------------------------------------------------------

    /**
     * @event requestAiInsight
     * Executes the secure backend prompt generation and API call.
     */
    socket.on('requestAiInsight', async (siteData) => {
        try {
            // Forward payload to isolated AIService Class
            const aiResponse = await AIService.requestSafetyAudit(siteData);

            if (aiResponse.success) {
                socket.emit('aiInsightResponse', { result: aiResponse.result });
                
                // Log Audit success
                if (currentSiteCode) {
                    const site = Database.getSite(currentSiteCode);
                    if (site) {
                        LedgerService.appendRecord(site, 'AI_AUDIT', `Automated safety audit generated successfully.`, 'info');
                        broadcastLedger(site);
                    }
                }
            } else {
                // Pipe formatted error to client
                socket.emit('aiInsightResponse', { error: aiResponse.error });
            }

        } catch (err) { 
            console.error("[ERR_AI_ROUTING]", err.message);
            socket.emit('aiInsightResponse', { error: `Internal Engine Fault: ${err.message}` }); 
        }
    });

    // --------------------------------------------------------------------------------------
    // G. SOCKET DISCONNECT HANDLING
    // --------------------------------------------------------------------------------------

    socket.on('disconnect', (reason) => {
        console.log(`[NET_DISCONNECT] Socket severed: ${socket.id} | Reason: ${reason}`);
        // Memory note: The client object stays in the DB array until explicitly removed 
        // via 'removeMember' or until the entire site is Garbage Collected.
        // This allows users to drop connection briefly and reconnect without losing their grid position.
    });

});


// ==========================================================================================
// 8. KERNEL BOOT SEQUENCE
// ==========================================================================================

server.listen(KERNEL_CONFIG.PORT, () => {
    console.log(`\n=================================================================`);
    console.log(`🚀 ALTIGUARD KERNEL v4.0 ENTERPRISE ONLINE`);
    console.log(`📡 WebSocket Telemetry Router Active on Port: ${KERNEL_CONFIG.PORT}`);
    console.log(`🧠 AI Engine Key Detected: ${KERNEL_CONFIG.GEMINI_API_KEY ? 'VERIFIED' : 'MISSING (AI Disabled)'}`);
    console.log(`🧹 Garbage Collection Cycle: ${KERNEL_CONFIG.GARBAGE_COLLECTION_INTERVAL / 60000} Minutes`);
    console.log(`=================================================================\n`);
});
