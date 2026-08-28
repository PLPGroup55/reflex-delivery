const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 🛡️ Q&A EXPLANATION: Secret key for signing JWTs. In production, use environment variables.
const JWT_SECRET = 'reflex-prototype-secret-key-2026';

// ==========================================
// IN-MEMORY DATA STORE
// ==========================================
const users = []; 

// 🛡️ UPDATED: 5 Riders. Some are available, some are already on delivery (available: false)
const riders = [
  { id: 'r1', name: 'John Rider', lat: -1.2921, lng: 36.8219, available: true },
  { id: 'r2', name: 'Jane Rider', lat: -1.2821, lng: 36.8319, available: false }, //  Currently on delivery
  { id: 'r3', name: 'Peter Otieno', lat: -1.2500, lng: 36.8000, available: true },
  { id: 'r4', name: 'Faith Nyambura', lat: -1.3000, lng: 36.8500, available: false }, // 🚴 Currently on delivery
  { id: 'r5', name: 'David Kimani', lat: -1.2700, lng: 36.7900, available: true }
];

const deliveries = []; 

let deliveryIdCounter = 1;
let userIdCounter = 1;

// ==========================================
// AUTH MIDDLEWARE
// ==========================================
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access denied.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token.' });
    req.user = { id: decoded.userId, role: decoded.role, name: decoded.name };
    next();
  });
};

// ==========================================
// AUTH ROUTES
// ==========================================
app.post('/auth/signup', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) return res.status(400).json({ error: 'All fields required.' });
    if (users.find(u => u.email === email)) return res.status(400).json({ error: 'Email exists.' });

    const passwordHash = await bcrypt.hash(password, 10);
    users.push({ id: `u${userIdCounter++}`, name, email, passwordHash, role });
    res.status(201).json({ message: 'User created' });
  } catch (error) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email);
    if (!user) return res.status(400).json({ error: 'Invalid credentials.' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials.' });

    const token = jwt.sign({ userId: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
  } catch (error) { res.status(500).json({ error: 'Server error.' }); }
});

// ==========================================
// PROTECTED ROUTES
// ==========================================
app.get('/riders', authenticateToken, (req, res) => res.json(riders));
app.get('/deliveries', authenticateToken, (req, res) => res.json(deliveries));

app.get('/riders/:riderId/deliveries', authenticateToken, (req, res) => {
  const { riderId } = req.params;
  res.json(deliveries.filter(d => d.assignedRiderId === riderId));
});

// 🛡️ CREATE DELIVERY: No auto-assignment. Status starts as 'unassigned'.
app.post('/deliveries', authenticateToken, (req, res) => {
  const { customerName, customerPhone, address, itemDescription } = req.body;
  
  const newDelivery = {
    id: `d${deliveryIdCounter++}`,
    customerName, customerPhone, address, itemDescription,
    status: 'unassigned', 
    assignedRiderId: null,
    pickupCode: Math.floor(1000 + Math.random() * 9000).toString(),
    deliveryCode: Math.floor(1000 + Math.random() * 9000).toString()
  };

  deliveries.push(newDelivery);
  io.emit('delivery_update', { type: 'created', delivery: newDelivery });
  res.status(201).json(newDelivery);
});

// 🛡️ ACCEPT DELIVERY: Rider accepts an unassigned delivery
app.post('/deliveries/:id/accept', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { riderId } = req.body; 
  
  const delivery = deliveries.find(d => d.id === id);
  const rider = riders.find(r => r.id === riderId);

  if (!delivery || delivery.status !== 'unassigned') return res.status(400).json({ error: 'Delivery not available.' });
  if (!rider) return res.status(400).json({ error: 'Rider not found.' });
  if (!rider.available) return res.status(400).json({ error: 'Rider is currently busy.' });

  delivery.status = 'assigned';
  delivery.assignedRiderId = riderId;
  rider.available = false; // Mark rider as busy

  io.emit('delivery_update', { type: 'accepted', delivery });
  res.json({ message: 'Delivery accepted!', delivery });
});

// ️ PICKUP: Rider confirms pickup with code
app.post('/deliveries/:id/pickup', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { pickupCode } = req.body;
  const delivery = deliveries.find(d => d.id === id);
  
  if (!delivery || delivery.status !== 'assigned') return res.status(400).json({ error: 'Invalid status.' });
  if (delivery.pickupCode !== pickupCode) return res.status(400).json({ error: 'Invalid pickup code.' });

  delivery.status = 'picked_up';
  io.emit('delivery_update', { type: 'picked_up', delivery });
  res.json({ message: 'Pickup confirmed!', delivery });
});

// 🛡️ CONFIRM DELIVERY: Rider confirms delivery with code (and becomes available again)
app.post('/deliveries/:id/confirm', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { confirmationCode } = req.body;
  const delivery = deliveries.find(d => d.id === id);
  
  if (!delivery || delivery.status !== 'picked_up') return res.status(400).json({ error: 'Must be picked up first.' });
  if (delivery.deliveryCode !== confirmationCode) return res.status(400).json({ error: 'Invalid delivery code.' });

  delivery.status = 'delivered';
  
  // 🛡️ Free up the rider for new jobs
  if (delivery.assignedRiderId) {
    const rider = riders.find(r => r.id === delivery.assignedRiderId);
    if (rider) rider.available = true;
  }

  io.emit('delivery_update', { type: 'confirmed', delivery });
  res.json({ message: 'Delivery completed!', delivery });
});

// ==========================================
// SOCKET.IO
// ==========================================
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  socket.on('disconnect', () => console.log('User disconnected:', socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Reflex running on http://localhost:${PORT}`));