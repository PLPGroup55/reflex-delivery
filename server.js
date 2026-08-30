const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = 'reflex-prototype-secret-key-2026';

const users = []; 
const riders = [
  { id: 'r1', name: 'John Rider', lat: -1.2921, lng: 36.8219, available: true },
  { id: 'r2', name: 'Jane Rider', lat: -1.2821, lng: 36.8319, available: false },
  { id: 'r3', name: 'Peter Otieno', lat: -1.2500, lng: 36.8000, available: true },
  { id: 'r4', name: 'Faith Nyambura', lat: -1.3000, lng: 36.8500, available: false },
  { id: 'r5', name: 'David Kimani', lat: -1.2700, lng: 36.7900, available: true }
];
const deliveries = []; 

let deliveryIdCounter = 1;
let userIdCounter = 1;

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', time: new Date().toISOString() });
});

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    console.log('No token provided');
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }
  
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      console.log('Invalid token:', err.message);
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }
    req.user = { id: decoded.userId, role: decoded.role, name: decoded.name };
    next();
  });
};

app.post('/auth/signup', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    console.log('Signup attempt:', { name, email, role });
    
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    
    if (users.find(u => u.email === email)) {
      return res.status(400).json({ error: 'Email already exists.' });
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = { id: `u${userIdCounter++}`, name, email, passwordHash, role };
    users.push(newUser);
    
    console.log('User created successfully:', newUser.id);
    res.status(201).json({ message: 'User created successfully' });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Server error during signup.' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log('Login attempt for:', email);
    
    const user = users.find(u => u.email === email);
    if (!user) {
      console.log('User not found:', email);
      return res.status(404).json({ error: 'Account does not exist. Please sign up.' });
    }
    
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      console.log('Invalid password for:', email);
      return res.status(400).json({ error: 'Invalid password.' });
    }
    
    const token = jwt.sign(
      { userId: user.id, role: user.role, name: user.name }, 
      JWT_SECRET, 
      { expiresIn: '24h' }
    );
    
    console.log('Login successful for:', email);
    res.json({ 
      token, 
      user: { id: user.id, name: user.name, role: user.role } 
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

app.get('/riders', authenticateToken, (req, res) => {
  res.json(riders);
});

app.get('/deliveries', authenticateToken, (req, res) => {
  console.log('Fetching deliveries for user:', req.user.name);
  res.json(deliveries);
});

app.post('/deliveries', authenticateToken, (req, res) => {
  try {
    const { customerName, customerPhone, address, itemDescription, deliveryFee } = req.body;
    
    console.log('Creating delivery:', { customerName, address, itemDescription, deliveryFee });
    
    if (!customerName || !customerPhone || !address || !itemDescription) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    
    const formattedId = `REF-2026-${String(deliveryIdCounter).padStart(3, '0')}`;
    
    const newDelivery = {
      id: formattedId,
      internalId: deliveryIdCounter++,
      customerName, 
      customerPhone, 
      address, 
      itemDescription,
      deliveryFee: deliveryFee || '0',
      status: 'unassigned', 
      assignedRiderId: null,
      pickupCode: Math.floor(1000 + Math.random() * 9000).toString(),
      deliveryCode: Math.floor(1000 + Math.random() * 9000).toString(),
      createdAt: new Date().toISOString(),
      createdBy: req.user.name
    };
    
    deliveries.push(newDelivery);
    console.log('Delivery created:', newDelivery.id);
    
    io.emit('delivery_update', { type: 'created', delivery: newDelivery });
    res.status(201).json(newDelivery);
  } catch (error) {
    console.error('Create delivery error:', error);
    res.status(500).json({ error: 'Failed to create delivery.' });
  }
});

app.post('/deliveries/:id/accept', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { riderId } = req.body; 
  const delivery = deliveries.find(d => d.id === id);
  const rider = riders.find(r => r.id === riderId);
  
  console.log('Accept delivery:', { id, riderId });

  if (!delivery || delivery.status !== 'unassigned') {
    return res.status(400).json({ error: 'Delivery not available.' });
  }
  if (!rider) {
    return res.status(400).json({ error: 'Rider not found.' });
  }
  if (!rider.available) {
    return res.status(400).json({ error: 'Rider is currently busy.' });
  }

  delivery.status = 'assigned';
  delivery.assignedRiderId = riderId;
  delivery.acceptedAt = new Date().toISOString();
  rider.available = false;

  io.emit('delivery_update', { type: 'accepted', delivery });
  res.json({ message: 'Delivery accepted!', delivery });
});

app.post('/deliveries/:id/pickup', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { pickupCode } = req.body;
  const delivery = deliveries.find(d => d.id === id);
  
  if (!delivery || delivery.status !== 'assigned') {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  if (delivery.pickupCode !== pickupCode) {
    return res.status(400).json({ error: 'Invalid pickup code.' });
  }

  delivery.status = 'picked_up';
  delivery.pickedUpAt = new Date().toISOString();
  io.emit('delivery_update', { type: 'picked_up', delivery });
  res.json({ message: 'Pickup confirmed!', delivery });
});

app.post('/deliveries/:id/confirm', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { confirmationCode } = req.body;
  const delivery = deliveries.find(d => d.id === id);
  
  if (!delivery || delivery.status !== 'picked_up') {
    return res.status(400).json({ error: 'Must be picked up first.' });
  }
  if (delivery.deliveryCode !== confirmationCode) {
    return res.status(400).json({ error: 'Invalid delivery code.' });
  }

  delivery.status = 'delivered';
  delivery.deliveredAt = new Date().toISOString();
  
  if (delivery.assignedRiderId) {
    const rider = riders.find(r => r.id === delivery.assignedRiderId);
    if (rider) rider.available = true;
  }

  io.emit('delivery_update', { type: 'confirmed', delivery });
  res.json({ message: 'Delivery completed!', delivery });
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  socket.on('disconnect', () => console.log('User disconnected:', socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Reflex server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});