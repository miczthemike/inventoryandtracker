const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = 3000;
const DB_FILE = path.join(__dirname, 'db.json');
const DB_TEMP_FILE = path.join(__dirname, 'db.tmp.json');
const DB_BACKUP_FILE = path.join(__dirname, 'db.bak.json');
const BACKUP_DIR = path.join(__dirname, 'backups');
const eventClients = new Set();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

function broadcastDataUpdated() {
    const message = `event: data-updated\ndata: ${JSON.stringify({ updatedAt: new Date().toISOString() })}\n\n`;
    for (const client of eventClients) {
        try {
            client.write(message);
        } catch (err) {
            console.error('[Events] Failed to notify a connected client:', err.message);
            eventClients.delete(client);
        }
    }
}

// Configure Multer for Image Uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// ============================================================
//  DATA SAFETY LAYER
// ============================================================

let writeLock = false;
const writeQueue = [];

function acquireWriteLock() {
    return new Promise((resolve) => {
        if (!writeLock) {
            writeLock = true;
            resolve();
        } else {
            writeQueue.push(resolve);
        }
    });
}

function releaseWriteLock() {
    if (writeQueue.length > 0) {
        const next = writeQueue.shift();
        next();
    } else {
        writeLock = false;
    }
}

function writeDB(data) {
    const jsonStr = JSON.stringify(data, null, 2);
    fs.writeFileSync(DB_TEMP_FILE, jsonStr, 'utf8');
    if (fs.existsSync(DB_FILE)) {
        try { fs.copyFileSync(DB_FILE, DB_BACKUP_FILE); } catch (err) {
            console.error('[DB] Warning: could not create hot backup:', err.message);
        }
    }
    fs.renameSync(DB_TEMP_FILE, DB_FILE);
    broadcastDataUpdated();
}

function readDB() {
    const mainResult = tryReadJSONFile(DB_FILE);
    if (mainResult) return migrateDB(mainResult);

    console.warn('[DB] Main db.json is corrupt or missing. Trying hot backup...');
    const bakResult = tryReadJSONFile(DB_BACKUP_FILE);
    if (bakResult) {
        console.log('[DB] ✔ Recovered from hot backup.');
        const migrated = migrateDB(bakResult);
        writeDB(migrated);
        return migrated;
    }

    console.warn('[DB] Hot backup unavailable. Trying latest daily backup...');
    const latestBackup = getLatestDailyBackup();
    if (latestBackup) {
        const dailyResult = tryReadJSONFile(latestBackup);
        if (dailyResult) {
            console.log(`[DB] ✔ Recovered from daily backup: ${path.basename(latestBackup)}`);
            const migrated = migrateDB(dailyResult);
            writeDB(migrated);
            return migrated;
        }
    }

    console.error('[DB] ✘ All recovery failed. Starting with empty database.');
    const emptyData = { items: [], requests: [], equipment: [], equipmentLogs: [] };
    writeDB(emptyData);
    return emptyData;
}

// Ensure new collections exist (migrate older db.json files)
function migrateDB(data) {
    let changed = false;
    if (!Array.isArray(data.items)) { data.items = []; changed = true; }
    if (!Array.isArray(data.requests)) { data.requests = []; changed = true; }
    if (!Array.isArray(data.equipment)) { data.equipment = []; changed = true; }
    if (!Array.isArray(data.equipmentLogs)) { data.equipmentLogs = []; changed = true; }
    data.items.forEach(item => {
        if (!Number.isInteger(item.lowStockThreshold) || item.lowStockThreshold < 0) {
            item.lowStockThreshold = 5;
            changed = true;
        }
    });
    data.equipment.forEach(equipment => {
        if (equipment.dueDate === undefined) {
            equipment.dueDate = null;
            changed = true;
        }
    });
    if (changed) writeDB(data);
    return data;
}

function isValidDateOnly(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getLocalDateKey(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : dateKey(date);
}

function getReportDateRange(query) {
    if (query.startDate || query.endDate) {
        if (!isValidDateOnly(query.startDate) || !isValidDateOnly(query.endDate) || query.startDate > query.endDate) {
            return { error: 'A valid startDate and endDate are required, and startDate must not be after endDate.' };
        }
        return { startDate: query.startDate, endDate: query.endDate };
    }

    const month = Number(query.month);
    const year = Number(query.year);
    if (!Number.isInteger(month) || month < 1 || month > 12 ||
        !Number.isInteger(year) || year < 1 || year > 9999) {
        return { error: 'Provide a valid date range or month and year.' };
    }
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { startDate, endDate: `${year}-${String(month).padStart(2, '0')}-${String(endDay).padStart(2, '0')}` };
}

function tryReadJSONFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (!content) return null;
        const data = JSON.parse(content);
        if (data && typeof data === 'object') return data;
        return null;
    } catch (err) {
        console.error(`[DB] Failed to read ${filePath}: ${err.message}`);
        return null;
    }
}

// ============================================================
//  DAILY BACKUP — 1× per day, 1-week retention
// ============================================================

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function createDailyBackup() {
    try {
        if (!fs.existsSync(DB_FILE)) return;
        const data = tryReadJSONFile(DB_FILE);
        if (!data) { console.warn('[Backup] Skipping — db.json is invalid.'); return; }

        const hasData = (data.items && data.items.length > 0) ||
                        (data.requests && data.requests.length > 0) ||
                        (data.equipment && data.equipment.length > 0) ||
                        (data.equipmentLogs && data.equipmentLogs.length > 0);
        if (!hasData) { console.log('[Backup] Skipping — database is empty.'); return; }

        const today = new Date().toISOString().split('T')[0];
        const backupFile = path.join(BACKUP_DIR, `db-backup-${today}.json`);
        if (fs.existsSync(backupFile)) { console.log(`[Backup] Already exists for ${today}.`); return; }

        fs.copyFileSync(DB_FILE, backupFile);
        console.log(`[Backup] ✔ Created: db-backup-${today}.json`);
        cleanOldBackups();
    } catch (err) { console.error(`[Backup] Failed: ${err.message}`); }
}

function cleanOldBackups() {
    try {
        const now = Date.now();
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
        fs.readdirSync(BACKUP_DIR).forEach(file => {
            if (!file.startsWith('db-backup-') || !file.endsWith('.json')) return;
            const filePath = path.join(BACKUP_DIR, file);
            if (now - fs.statSync(filePath).mtimeMs > SEVEN_DAYS_MS) {
                fs.unlinkSync(filePath);
                console.log(`[Backup] 🗑 Deleted expired: ${file}`);
            }
        });
    } catch (err) { console.error(`[Backup] Cleanup failed: ${err.message}`); }
}

function getLatestDailyBackup() {
    try {
        if (!fs.existsSync(BACKUP_DIR)) return null;
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('db-backup-') && f.endsWith('.json'))
            .sort().reverse();
        return files.length > 0 ? path.join(BACKUP_DIR, files[0]) : null;
    } catch { return null; }
}

createDailyBackup();
setInterval(createDailyBackup, 24 * 60 * 60 * 1000);

// ============================================================
//  INITIALIZE
// ============================================================

const initialDB = readDB();
console.log(`[DB] Loaded: ${initialDB.items.length} consumables, ${initialDB.equipment.length} equipment, ${initialDB.requests.length} requests.`);

app.get('/api/events', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    res.write('event: connected\ndata: {}\n\n');
    eventClients.add(res);

    const heartbeat = setInterval(() => {
        try {
            res.write(': keep-alive\n\n');
        } catch (err) {
            console.error('[Events] Lost a live update client:', err.message);
            clearInterval(heartbeat);
            eventClients.delete(res);
            res.end();
        }
    }, 25000);
    res.on('close', () => {
        clearInterval(heartbeat);
        eventClients.delete(res);
    });
});

// ============================================================
//  API ROUTES — CONSUMABLES
// ============================================================

app.get('/api/data', (req, res) => {
    try { res.json(readDB()); }
    catch (err) { res.status(500).json({ success: false, message: 'Failed to read database.' }); }
});

app.post('/api/items', upload.single('photo'), async (req, res) => {
    await acquireWriteLock();
    try {
        const quantity = Number(req.body.quantity);
        const lowStockThreshold = Number(req.body.lowStockThreshold ?? 5);
        if (!req.body.name?.trim() || !req.body.category?.trim() ||
            !Number.isInteger(quantity) || quantity < 0 ||
            !Number.isInteger(lowStockThreshold) || lowStockThreshold < 0) {
            return res.status(400).json({ success: false, message: 'Enter an item name, category, non-negative quantity, and valid low-stock threshold.' });
        }
        const db = readDB();
        const newItem = {
            id: Date.now().toString(),
            name: req.body.name.trim(),
            category: req.body.category.trim(),
            quantity,
            lowStockThreshold,
            photo: req.file ? `/uploads/${req.file.filename}` : null
        };
        db.items.push(newItem);
        writeDB(db);
        res.json({ success: true, item: newItem });
    } catch (err) {
        console.error('[API] Error adding item:', err.message);
        res.status(500).json({ success: false, message: 'Failed to add item.' });
    } finally { releaseWriteLock(); }
});

app.post('/api/items/:id/adjust', async (req, res) => {
    await acquireWriteLock();
    try {
        const db = readDB();
        const item = db.items.find(entry => entry.id === req.params.id);
        if (!item) return res.status(404).json({ success: false, message: 'Item not found.' });

        const adjustment = Number(req.body.adjustment);
        const threshold = req.body.lowStockThreshold === undefined
            ? item.lowStockThreshold
            : Number(req.body.lowStockThreshold);
        if (!Number.isInteger(adjustment) ||
            !Number.isInteger(threshold) || threshold < 0 ||
            item.quantity + adjustment < 0) {
            return res.status(400).json({ success: false, message: 'Stock adjustment must be a whole number that does not make stock negative; threshold must be a non-negative whole number.' });
        }

        item.quantity += adjustment;
        item.lowStockThreshold = threshold;
        writeDB(db);
        res.json({ success: true, item });
    } catch (err) {
        console.error('[API] Error adjusting consumable stock:', err.message);
        res.status(500).json({ success: false, message: 'Failed to adjust stock.' });
    } finally { releaseWriteLock(); }
});

app.post('/api/requests', async (req, res) => {
    await acquireWriteLock();
    try {
        const db = readDB();
        const { itemId, requestor, department, quantityRequested } = req.body;
        const quantity = Number(quantityRequested);
        const item = db.items.find(i => i.id === itemId);
        if (!Number.isInteger(quantity) || quantity <= 0) {
            return res.status(400).json({ success: false, message: 'Request quantity must be a whole number greater than zero.' });
        }
        if (!requestor?.trim() || !department?.trim()) {
            return res.status(400).json({ success: false, message: 'Requestor and department are required.' });
        }
        if (!item || item.quantity < quantity) {
            return res.status(400).json({ success: false, message: 'Insufficient stock or item not found.' });
        }
        item.quantity -= quantity;
        const newRequest = {
            id: Date.now().toString(),
            itemId, itemName: item.name, requestor: requestor.trim(), department: department.trim(),
            quantity,
            date: new Date().toISOString()
        };
        db.requests.push(newRequest);
        writeDB(db);
        res.json({ success: true, request: newRequest });
    } catch (err) {
        console.error('[API] Error processing request:', err.message);
        res.status(500).json({ success: false, message: 'Failed to process request.' });
    } finally { releaseWriteLock(); }
});

// ============================================================
//  API ROUTES — IT EQUIPMENT TRACKER
// ============================================================

// Get all equipment
app.get('/api/equipment', (req, res) => {
    try {
        const db = readDB();
        res.json(db.equipment);
    } catch (err) { res.status(500).json({ success: false, message: 'Failed to read equipment.' }); }
});

// Add new equipment
app.post('/api/equipment', upload.single('photo'), async (req, res) => {
    await acquireWriteLock();
    try {
        const db = readDB();
        const newEquipment = {
            id: Date.now().toString(),
            name: req.body.name,
            category: req.body.category,
            serialNumber: req.body.serialNumber || '',
            homeLocation: req.body.homeLocation || 'IT Storage',
            currentLocation: req.body.homeLocation || 'IT Storage',
            status: 'available',   // available | checked-out | maintenance
            condition: req.body.condition || 'good',
            borrower: null,
            department: null,
            eventHall: null,
            dateCheckedOut: null,
            dueDate: null,
            photo: req.file ? `/uploads/${req.file.filename}` : null,
            dateAdded: new Date().toISOString()
        };
        db.equipment.push(newEquipment);
        writeDB(db);
        res.json({ success: true, equipment: newEquipment });
    } catch (err) {
        console.error('[API] Error adding equipment:', err.message);
        res.status(500).json({ success: false, message: 'Failed to add equipment.' });
    } finally { releaseWriteLock(); }
});

// Update equipment details
app.put('/api/equipment/:id', upload.single('photo'), async (req, res) => {
    await acquireWriteLock();
    try {
        const db = readDB();
        const eq = db.equipment.find(e => e.id === req.params.id);
        if (!eq) return res.status(404).json({ success: false, message: 'Equipment not found.' });

        if (req.body.dueDate !== undefined &&
            (eq.status !== 'checked-out' || !isValidDateOnly(req.body.dueDate))) {
            return res.status(400).json({ success: false, message: 'A valid due date can only be set for deployed equipment.' });
        }
        if (req.body.name?.trim()) eq.name = req.body.name.trim();
        if (req.body.category?.trim()) eq.category = req.body.category.trim();
        if (req.body.serialNumber !== undefined) eq.serialNumber = req.body.serialNumber;
        if (req.body.homeLocation?.trim()) {
            eq.homeLocation = req.body.homeLocation.trim();
            if (eq.status !== 'checked-out') eq.currentLocation = eq.homeLocation;
        }
        if (req.body.condition) eq.condition = req.body.condition;
        if (req.body.dueDate !== undefined) {
            eq.dueDate = req.body.dueDate;
            const latestDeployment = db.equipmentLogs.slice().reverse().find(log =>
                log.equipmentId === eq.id && log.action === 'checkout'
            );
            if (latestDeployment) latestDeployment.dueDate = req.body.dueDate;
        }
        if (req.body.status === 'available' && eq.status === 'maintenance') {
            eq.status = 'available';
            eq.currentLocation = eq.homeLocation;
            eq.borrower = null;
            eq.department = null;
            eq.eventHall = null;
            eq.dateCheckedOut = null;
            eq.dueDate = null;
        }
        if (req.file) eq.photo = `/uploads/${req.file.filename}`;

        writeDB(db);
        res.json({ success: true, equipment: eq });
    } catch (err) {
        console.error('[API] Error updating equipment:', err.message);
        res.status(500).json({ success: false, message: 'Failed to update equipment.' });
    } finally { releaseWriteLock(); }
});

// Delete equipment
app.delete('/api/equipment/:id', async (req, res) => {
    await acquireWriteLock();
    try {
        const db = readDB();
        const idx = db.equipment.findIndex(e => e.id === req.params.id);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Equipment not found.' });
        if (db.equipment[idx].status === 'checked-out') {
            return res.status(400).json({ success: false, message: 'Deployed equipment must be returned before it can be removed.' });
        }
        db.equipment.splice(idx, 1);
        writeDB(db);
        res.json({ success: true });
    } catch (err) {
        console.error('[API] Error deleting equipment:', err.message);
        res.status(500).json({ success: false, message: 'Failed to delete equipment.' });
    } finally { releaseWriteLock(); }
});

// Checkout equipment
app.post('/api/equipment/:id/checkout', async (req, res) => {
    await acquireWriteLock();
    try {
        const db = readDB();
        const eq = db.equipment.find(e => e.id === req.params.id);
        if (!eq) return res.status(404).json({ success: false, message: 'Equipment not found.' });
        if (eq.status === 'checked-out') {
            return res.status(400).json({ success: false, message: `Already checked out to ${eq.borrower}.` });
        }
        if (eq.status === 'maintenance') {
            return res.status(400).json({ success: false, message: 'Equipment is under maintenance.' });
        }

        const { borrower, department, eventHall, notes, dueDate } = req.body;
        if (!borrower?.trim() || !department?.trim() || !eventHall?.trim() ||
            !isValidDateOnly(dueDate) || dueDate < dateKey(new Date())) {
            return res.status(400).json({ success: false, message: 'Borrower, department, event hall, and a valid due date today or later are required.' });
        }
        eq.status = 'checked-out';
        eq.borrower = borrower.trim();
        eq.department = department.trim();
        eq.eventHall = eventHall.trim();
        eq.currentLocation = eventHall.trim();
        eq.dateCheckedOut = new Date().toISOString();
        eq.dueDate = dueDate;

        const log = {
            id: Date.now().toString(),
            equipmentId: eq.id,
            equipmentName: eq.name,
            action: 'checkout',
            borrower: borrower.trim(), department: department.trim(),
            location: eventHall.trim(),
            dueDate,
            notes: notes || '',
            date: new Date().toISOString()
        };
        db.equipmentLogs.push(log);
        writeDB(db);
        res.json({ success: true, equipment: eq, log });
    } catch (err) {
        console.error('[API] Error checking out equipment:', err.message);
        res.status(500).json({ success: false, message: 'Failed to checkout equipment.' });
    } finally { releaseWriteLock(); }
});

// Return equipment
app.post('/api/equipment/:id/return', async (req, res) => {
    await acquireWriteLock();
    try {
        const db = readDB();
        const eq = db.equipment.find(e => e.id === req.params.id);
        if (!eq) return res.status(404).json({ success: false, message: 'Equipment not found.' });
        if (eq.status !== 'checked-out') {
            return res.status(400).json({ success: false, message: 'Equipment is not checked out.' });
        }

        const { notes, condition } = req.body;
        const dueDate = eq.dueDate || null;
        const log = {
            id: Date.now().toString(),
            equipmentId: eq.id,
            equipmentName: eq.name,
            action: 'return',
            borrower: eq.borrower,
            department: eq.department,
            location: 'IT Room',
            dueDate,
            notes: notes || '',
            date: new Date().toISOString()
        };
        db.equipmentLogs.push(log);

        eq.status = 'available';
        eq.currentLocation = 'IT Room';
        eq.borrower = null;
        eq.department = null;
        eq.eventHall = null;
        eq.dateCheckedOut = null;
        eq.dueDate = null;
        if (condition) eq.condition = condition;

        writeDB(db);
        res.json({ success: true, equipment: eq, log });
    } catch (err) {
        console.error('[API] Error returning equipment:', err.message);
        res.status(500).json({ success: false, message: 'Failed to return equipment.' });
    } finally { releaseWriteLock(); }
});

// Set equipment to maintenance
app.post('/api/equipment/:id/maintenance', async (req, res) => {
    await acquireWriteLock();
    try {
        const db = readDB();
        const eq = db.equipment.find(e => e.id === req.params.id);
        if (!eq) return res.status(404).json({ success: false, message: 'Equipment not found.' });
        if (eq.status === 'checked-out') {
            return res.status(400).json({ success: false, message: 'Return deployed equipment before marking it for maintenance.' });
        }

        const { notes } = req.body;
        eq.status = 'maintenance';
        eq.currentLocation = 'Under Maintenance';

        const log = {
            id: Date.now().toString(),
            equipmentId: eq.id,
            equipmentName: eq.name,
            action: 'maintenance',
            borrower: eq.borrower || '',
            department: eq.department || '',
            location: 'Maintenance',
            notes: notes || '',
            date: new Date().toISOString()
        };
        db.equipmentLogs.push(log);
        eq.borrower = null;
        eq.department = null;
        eq.eventHall = null;
        eq.dateCheckedOut = null;
        eq.dueDate = null;

        writeDB(db);
        res.json({ success: true, equipment: eq, log });
    } catch (err) {
        console.error('[API] Error setting maintenance:', err.message);
        res.status(500).json({ success: false, message: 'Failed to update equipment.' });
    } finally { releaseWriteLock(); }
});

// Get equipment logs
app.get('/api/equipment/logs', (req, res) => {
    try {
        const db = readDB();
        res.json(db.equipmentLogs);
    } catch (err) { res.status(500).json({ success: false, message: 'Failed to read logs.' }); }
});

// ============================================================
//  API ROUTES — ANALYTICS
// ============================================================

app.get('/api/analytics/consumables', (req, res) => {
    try {
        const db = readDB();
        const range = getReportDateRange(req.query);
        if (range.error) return res.status(400).json({ success: false, message: range.error });

        // ISO date prefixes keep date-only boundaries inclusive.
        const filtered = db.requests.filter(r => {
            const date = getLocalDateKey(r.date);
            return date >= range.startDate && date <= range.endDate;
        });

        const totalQuantity = filtered.reduce((sum, r) => sum + r.quantity, 0);

        // By Item
        const byItemMap = {};
        filtered.forEach(r => {
            if (!byItemMap[r.itemName]) byItemMap[r.itemName] = { itemName: r.itemName, totalQuantity: 0, transactions: 0 };
            byItemMap[r.itemName].totalQuantity += r.quantity;
            byItemMap[r.itemName].transactions += 1;
        });
        const byItem = Object.values(byItemMap).sort((a, b) => b.totalQuantity - a.totalQuantity);

        // By Department
        const byDeptMap = {};
        filtered.forEach(r => {
            if (!byDeptMap[r.department]) byDeptMap[r.department] = { department: r.department, totalQuantity: 0, transactions: 0 };
            byDeptMap[r.department].totalQuantity += r.quantity;
            byDeptMap[r.department].transactions += 1;
        });
        const byDepartment = Object.values(byDeptMap).sort((a, b) => b.totalQuantity - a.totalQuantity);

        // By Requestor and Department
        const byRequestorMap = new Map();
        filtered.forEach(r => {
            const requestor = r.requestor || 'Not recorded';
            const department = r.department || 'Not recorded';
            const key = JSON.stringify([requestor, department]);
            if (!byRequestorMap.has(key)) {
                byRequestorMap.set(key, { requestor, department, totalQuantity: 0, transactions: 0 });
            }
            const entry = byRequestorMap.get(key);
            entry.totalQuantity += r.quantity;
            entry.transactions += 1;
        });
        const byRequestor = Array.from(byRequestorMap.values())
            .sort((a, b) => b.totalQuantity - a.totalQuantity);

        // By Category (look up item category from items list)
        const itemCategoryMap = {};
        db.items.forEach(i => { itemCategoryMap[i.name] = i.category; });
        const byCatMap = {};
        filtered.forEach(r => {
            const cat = itemCategoryMap[r.itemName] || 'Uncategorized';
            if (!byCatMap[cat]) byCatMap[cat] = { category: cat, totalQuantity: 0, transactions: 0 };
            byCatMap[cat].totalQuantity += r.quantity;
            byCatMap[cat].transactions += 1;
        });
        const byCategory = Object.values(byCatMap).sort((a, b) => b.totalQuantity - a.totalQuantity);

        // Daily breakdown
        const byDayMap = {};
        filtered.forEach(r => {
            const day = getLocalDateKey(r.date);
            if (!day) return;
            if (!byDayMap[day]) byDayMap[day] = { date: day, totalQuantity: 0, transactions: 0 };
            byDayMap[day].totalQuantity += r.quantity;
            byDayMap[day].transactions += 1;
        });
        const dailyBreakdown = Object.values(byDayMap).sort((a, b) => a.date.localeCompare(b.date));

        // Current stock snapshot
        const stockSnapshot = db.items.map(i => ({
            name: i.name, category: i.category, currentStock: i.quantity,
            lowStockThreshold: i.lowStockThreshold
        })).sort((a, b) => a.currentStock - b.currentStock);

        res.json({
            success: true,
            period: range,
            totalTransactions: filtered.length,
            totalQuantity,
            byItem, byDepartment, byRequestor, byCategory,
            dailyBreakdown, stockSnapshot,
            transactions: filtered.map(r => ({
                date: r.date,
                itemName: r.itemName,
                requestor: r.requestor || '',
                department: r.department || '',
                quantity: r.quantity
            }))
        });
    } catch (err) {
        console.error('[API] Analytics error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to generate analytics.' });
    }
});

// Equipment utilization analytics
app.get('/api/analytics/equipment', (req, res) => {
    try {
        const db = readDB();
        const hasDateFilter = req.query.startDate || req.query.endDate || req.query.month || req.query.year;
        const range = hasDateFilter ? getReportDateRange(req.query) : null;
        if (range?.error) return res.status(400).json({ success: false, message: range.error });

        const totalEquipment = db.equipment.length;
        const available = db.equipment.filter(e => e.status === 'available').length;
        const checkedOut = db.equipment.filter(e => e.status === 'checked-out').length;
        const maintenance = db.equipment.filter(e => e.status === 'maintenance').length;

        const filteredLogs = range
            ? db.equipmentLogs.filter(log => {
                const date = getLocalDateKey(log.date);
                return date >= range.startDate && date <= range.endDate;
            })
            : db.equipmentLogs;

        // Most used equipment (by checkout count)
        const usageMap = {};
        filteredLogs.filter(l => l.action === 'checkout').forEach(l => {
            if (!usageMap[l.equipmentName]) usageMap[l.equipmentName] = { name: l.equipmentName, checkouts: 0 };
            usageMap[l.equipmentName].checkouts += 1;
        });
        const mostUsed = Object.values(usageMap).sort((a, b) => b.checkouts - a.checkouts);
        const deployments = filteredLogs
            .filter(log => log.action === 'checkout')
            .map(log => ({
                date: log.date,
                equipmentName: log.equipmentName,
                borrower: log.borrower || '',
                department: log.department || '',
                location: log.location || '',
                dueDate: log.dueDate || '',
                notes: log.notes || ''
            }));

        // By location/event hall
        const locationMap = {};
        filteredLogs.filter(l => l.action === 'checkout' && l.location).forEach(l => {
            if (!locationMap[l.location]) locationMap[l.location] = { location: l.location, count: 0 };
            locationMap[l.location].count += 1;
        });
        const byLocation = Object.values(locationMap).sort((a, b) => b.count - a.count);

        res.json({
            success: true,
            period: range,
            summary: { totalEquipment, available, checkedOut, maintenance },
            mostUsed, deployments, byLocation,
            totalLogs: filteredLogs.length
        });
    } catch (err) {
        console.error('[API] Equipment analytics error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to generate equipment analytics.' });
    }
});

// ============================================================

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
