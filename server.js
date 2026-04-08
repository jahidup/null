require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*', credentials: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== MongoDB Models ====================
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true },
  username: String,
  email: String,
  passwordHash: String,
  dailyLimit: { type: Number, default: 100 },
  searchesToday: { type: Number, default: 0 },
  lastResetDate: { type: String, default: () => new Date().toDateString() },
  isBlocked: { type: Boolean, default: false },
  blockReason: String,
  adminMessage: String,
  createdAt: { type: Date, default: Date.now },
  lastLogin: Date
});

const apiConfigSchema = new mongoose.Schema({
  key: { type: String, unique: true },   // e.g., 'phone', 'aadhaar'
  url: String,
  param: String,
  desc: String,
  extraBlacklist: [String]
});

const searchLogSchema = new mongoose.Schema({
  userId: String,
  apiType: String,
  query: String,
  timestamp: { type: Date, default: Date.now },
  responseTime: Number,
  success: Boolean,
  responseData: String   // truncated
});

const User = mongoose.model('User', userSchema);
const ApiConfig = mongoose.model('ApiConfig', apiConfigSchema);
const SearchLog = mongoose.model('SearchLog', searchLogSchema);

// ==================== Connect to MongoDB ====================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

// ==================== Seed default API configs ====================
const DEFAULT_ENDPOINTS = {
  phone: { url: 'https://ayaanmods.site/number.php?key=annonymous&number={}', param: 'number', desc: 'Mobile number lookup', extraBlacklist: ['channel_link', 'channel_name', 'API_Developer'] },
  aadhaar: { url: 'https://users-xinfo-admin.vercel.app/api?key=7demo&type=aadhar&term={}', param: 'match', desc: 'Aadhaar lookup', extraBlacklist: ['tag'] },
  ration: { url: 'https://number8899.vercel.app/?type=family&aadhar={}', param: 'id', desc: 'Ration card lookup', extraBlacklist: ['developer', 'credit'] },
  vehicle: { url: 'https://vehicle-info-aco-api.vercel.app/info?vehicle={}', param: 'vehicle', desc: 'Vehicle RC lookup', extraBlacklist: [] },
  vehicle_chalan: { url: 'https://api.b77bf911.workers.dev/vehicle?registration={}', param: 'registration', desc: 'Vehicle chalan lookup', extraBlacklist: [] },
  vehicle_pro: { url: 'https://users-xinfo-admin.vercel.app/api?key=7demo&type=vehicle&term={}', param: 'rc', desc: 'Vehicle pro lookup', extraBlacklist: ['tag', 'owner'] },
  ifsc: { url: 'https://ab-ifscinfoapi.vercel.app/info?ifsc={}', param: 'ifsc', desc: 'IFSC code lookup', extraBlacklist: [] },
  email: { url: 'https://abbas-apis.vercel.app/api/email?mail={}', param: 'mail', desc: 'Email lookup', extraBlacklist: [] },
  pincode: { url: 'https://api.postalpincode.in/pincode/{}', param: 'pincode', desc: 'Pincode lookup', extraBlacklist: [] },
  gst: { url: 'https://api.b77bf911.workers.dev/gst?number={}', param: 'number', desc: 'GST number lookup', extraBlacklist: ['source'] },
  tg_to_num: { url: 'https://rootx-tg-num-multi.satyamrajsingh562.workers.dev/3/{}?key=root', param: 'userid', desc: 'Telegram to number lookup', extraBlacklist: ['by'] },
  ip_info: { url: 'https://abbas-apis.vercel.app/api/ip?ip={}', param: 'ip', desc: 'IP address lookup', extraBlacklist: [] },
  ff_info: { url: 'https://abbas-apis.vercel.app/api/ff-info?uid={}', param: 'uid', desc: 'Free Fire info lookup', extraBlacklist: ['channel', 'Developer', 'channel'] },
  ff_ban: { url: 'https://abbas-apis.vercel.app/api/ff-ban?uid={}', param: 'uid', desc: 'Free Fire ban check', extraBlacklist: [] },
  tg_info_pro: { url: 'https://tg-to-num-six.vercel.app/?key=rootxsuryansh&q={}', param: 'user', desc: 'Telegram pro lookup', extraBlacklist: ['note', 'help_group', 'admin', 'owner', 'credit', 'response_time'] },
  tg_info: { url: 'https://api.b77bf911.workers.dev/telegram?user={}', param: 'user', desc: 'Telegram info lookup', extraBlacklist: ['source'] },
  insta_info: { url: 'https://mkhossain.alwaysdata.net/instanum.php?username={}', param: 'username', desc: 'Instagram info lookup', extraBlacklist: [] },
  github_info: { url: 'https://abbas-apis.vercel.app/api/github?username={}', param: 'username', desc: 'GitHub info lookup', extraBlacklist: [] }
};

async function seedApiConfigs() {
  for (const [key, cfg] of Object.entries(DEFAULT_ENDPOINTS)) {
    const exists = await ApiConfig.findOne({ key });
    if (!exists) {
      await ApiConfig.create({ key, ...cfg });
      console.log(`📝 Seeded API config: ${key}`);
    }
  }
}
seedApiConfigs();

// ==================== Helper: Reset daily counts ====================
async function resetDailyCounts() {
  const today = new Date().toDateString();
  const users = await User.find();
  for (const user of users) {
    if (user.lastResetDate !== today) {
      user.searchesToday = 0;
      user.lastResetDate = today;
      await user.save();
    }
  }
}
setInterval(resetDailyCounts, 60 * 60 * 1000); // every hour

// ==================== Middleware: User JWT ====================
function authUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.USER_JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ==================== Middleware: Admin JWT ====================
function authAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No admin token' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    if (decoded.role !== 'admin') throw new Error();
    req.admin = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid admin token' });
  }
}

// ==================== User Routes ====================
app.post('/user/login', async (req, res) => {
  const { userId, password } = req.body;
  if (!userId || !password) return res.status(400).json({ error: 'User ID and password required' });
  const user = await User.findOne({ userId });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.isBlocked) return res.status(403).json({ error: 'Account blocked', reason: user.blockReason });
  user.lastLogin = new Date();
  await user.save();
  const token = jwt.sign({ userId: user.userId, role: 'user' }, process.env.USER_JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { userId: user.userId, username: user.username, dailyLimit: user.dailyLimit, searchesToday: user.searchesToday, adminMessage: user.adminMessage } });
});

app.get('/user/me', authUser, async (req, res) => {
  const user = await User.findOne({ userId: req.user.userId }).select('-passwordHash');
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// Protected API endpoint (same functionality as before, but with user limits & logging)
app.get('/api', authUser, async (req, res) => {
  const { type, query, extra, remove_branding } = req.query;
  if (!type || !query) return res.status(400).json({ error: 'Missing type or query' });

  const user = await User.findOne({ userId: req.user.userId });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.isBlocked) return res.status(403).json({ error: 'Blocked', reason: user.blockReason });

  // Daily limit check
  const today = new Date().toDateString();
  if (user.lastResetDate !== today) {
    user.searchesToday = 0;
    user.lastResetDate = today;
  }
  if (user.searchesToday >= user.dailyLimit) {
    return res.status(429).json({ error: 'Daily search limit reached', limit: user.dailyLimit });
  }

  const apiConfig = await ApiConfig.findOne({ key: type.toLowerCase() });
  if (!apiConfig) return res.status(400).json({ error: 'Unknown API type' });

  const startTime = Date.now();
  let result, success = false;
  try {
    const url = apiConfig.url.replace('{}', encodeURIComponent(query));
    const response = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    result = response.data;
    success = true;
  } catch (err) {
    result = { error: 'External API failed', message: err.message };
  }
  const responseTime = Date.now() - startTime;

  // Log to MongoDB
  await SearchLog.create({
    userId: user.userId,
    apiType: type,
    query,
    responseTime,
    success,
    responseData: JSON.stringify(result).substring(0, 5000)
  });

  // Increment user's daily count
  user.searchesToday += 1;
  await user.save();

  // Clean response (blacklist + branding)
  function cleanObject(obj, blacklist) {
    if (!obj || typeof obj !== 'object') return obj;
    const newObj = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj)) {
      if (!blacklist.includes(k.toLowerCase())) {
        newObj[k] = (typeof v === 'object') ? cleanObject(v, blacklist) : v;
      }
    }
    return newObj;
  }
  const blacklist = (apiConfig.extraBlacklist || []).map(s => s.toLowerCase());
  if (remove_branding !== 'false') {
    result = cleanObject(result, blacklist);
  }
  // Add footer
  result.developer = 'Shahid Ansari';
  result.powered_by = 'NULL PROTOCOL';
  res.json(result);
});

// ==================== Admin Routes ====================
// Admin login (4-step)
app.post('/admin/login', (req, res) => {
  const { username, password, pin, key } = req.body;
  if (username === process.env.ADMIN_USERNAME &&
      password === process.env.ADMIN_PASSWORD &&
      pin === process.env.ADMIN_PIN &&
      key === process.env.ADMIN_SECURITY_KEY) {
    const token = jwt.sign({ role: 'admin' }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1d' });
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, error: 'Invalid admin credentials' });
  }
});

// CRUD Users
app.get('/admin/users', authAdmin, async (req, res) => {
  const users = await User.find().select('-passwordHash');
  res.json(users);
});

app.post('/admin/users', authAdmin, async (req, res) => {
  const { userId, username, email, password, dailyLimit } = req.body;
  if (!userId || !password) return res.status(400).json({ error: 'userId and password required' });
  const exists = await User.findOne({ userId });
  if (exists) return res.status(409).json({ error: 'User ID already exists' });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = new User({ userId, username, email, passwordHash, dailyLimit: dailyLimit || 100 });
  await user.save();
  res.json({ success: true, user: { userId, username, email, dailyLimit: user.dailyLimit } });
});

app.put('/admin/users/:userId', authAdmin, async (req, res) => {
  const { dailyLimit, isBlocked, blockReason, adminMessage } = req.body;
  const user = await User.findOne({ userId: req.params.userId });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (dailyLimit !== undefined) user.dailyLimit = dailyLimit;
  if (isBlocked !== undefined) user.isBlocked = isBlocked;
  if (blockReason !== undefined) user.blockReason = blockReason;
  if (adminMessage !== undefined) user.adminMessage = adminMessage;
  await user.save();
  res.json({ success: true });
});

app.delete('/admin/users/:userId', authAdmin, async (req, res) => {
  await User.deleteOne({ userId: req.params.userId });
  res.json({ success: true });
});

// API Configs management
app.get('/admin/api-configs', authAdmin, async (req, res) => {
  const configs = await ApiConfig.find();
  res.json(configs);
});

app.put('/admin/api-configs/:key', authAdmin, async (req, res) => {
  const { url, param, desc, extraBlacklist } = req.body;
  const config = await ApiConfig.findOneAndUpdate(
    { key: req.params.key },
    { url, param, desc, extraBlacklist: extraBlacklist || [] },
    { new: true }
  );
  if (!config) return res.status(404).json({ error: 'Config not found' });
  res.json(config);
});

// Search logs
app.get('/admin/logs', authAdmin, async (req, res) => {
  const { userId, limit = 100 } = req.query;
  const filter = userId ? { userId } : {};
  const logs = await SearchLog.find(filter).sort({ timestamp: -1 }).limit(parseInt(limit));
  res.json(logs);
});

// Send message to a user
app.post('/admin/send-message', authAdmin, async (req, res) => {
  const { userId, message } = req.body;
  await User.updateOne({ userId }, { adminMessage: message });
  res.json({ success: true });
});

// ==================== Serve Frontends ====================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==================== Start Server ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
