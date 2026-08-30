const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = 'reflex-prototype-secret-key-2026';

const users = []; 
const riders = [
  { id: 'r1', name: 'John Rider', available: true },
  { id: 'r2', name: 'Jane Rider', available: true }, 
  { id: 'r3', name: 'Peter Otieno', available: true },
  { id: 'r4', name: 'Faith Nyambura', available: true },
  { id: 'r5', name: 'David Kimani', available: true }
];
const deliveries = []; 
let deliveryIdCounter = 1;
let userIdCounter = 1;

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = { id: decoded.userId, role: decoded.role, name: decoded.name };
    next();
  });
};

app.post('/auth/signup', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) return res.status(400).json({ error: 'All fields required' });
    if (users.find(u => u.email === email)) return res.status(400).json({ error: 'Email already exists' });
    const passwordHash = await bcrypt.hash(password, 10);
    users.push({ id: `u${userIdCounter++}`, name, email, passwordHash, role });
    res.status(201).json({ message: 'User created' });
  } catch (error) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: 'Account does not exist. Please sign up.' });
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(400).json({ error: 'Invalid password' });
    const token = jwt.sign({ userId: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
  } catch (error) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/riders', authenticateToken, (req, res) => res.json(riders));
app.get('/deliveries', authenticateToken, (req, res) => res.json(deliveries));

app.post('/deliveries', authenticateToken, (req, res) => {
  try {
    const { customerName, customerPhone, address, itemDescription, itemPrice, deliveryFee } = req.body;
    const formattedId = `REF-2026-${String(deliveryIdCounter).padStart(3, '0')}`;
    const totalAmount = (Number(itemPrice) || 0) + (Number(deliveryFee) || 0);
    const newDelivery = {
      id: formattedId,
      internalId: deliveryIdCounter++,
      customerName, customerPhone, address, itemDescription,
      itemPrice: itemPrice || '0',
      deliveryFee: deliveryFee || '0',
      totalAmount: totalAmount.toString(),
      status: 'unassigned', 
      assignedRiderId: null,
      pickupCode: Math.floor(1000 + Math.random() * 9000).toString(),
      deliveryCode: Math.floor(1000 + Math.random() * 9000).toString(),
      createdAt: new Date().toISOString()
    };
    deliveries.push(newDelivery);
    io.emit('delivery_update', { type: 'created', delivery: newDelivery });
    res.status(201).json(newDelivery);
  } catch (error) { res.status(500).json({ error: 'Failed to create delivery' }); }
});

// ✅ NEW: Edit Delivery Route
app.put('/deliveries/:id', authenticateToken, (req, res) => {
  try {
    const { id } = req.params;
    const delivery = deliveries.find(d => d.id === id);
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    
    // Safety: Only allow editing if it hasn't been assigned to a rider yet
    if (delivery.status !== 'unassigned') {
      return res.status(400).json({ error: 'Cannot edit a delivery that has already been assigned.' });
    }

    const { customerName, customerPhone, address, itemDescription, itemPrice, deliveryFee } = req.body;
    delivery.customerName = customerName;
    delivery.customerPhone = customerPhone;
    delivery.address = address;
    delivery.itemDescription = itemDescription;
    delivery.itemPrice = itemPrice;
    delivery.deliveryFee = deliveryFee;
    delivery.totalAmount = ((Number(itemPrice) || 0) + (Number(deliveryFee) || 0)).toString();

    io.emit('delivery_update', { type: 'updated', delivery });
    res.json({ message: 'Updated successfully', delivery });
  } catch (error) { res.status(500).json({ error: 'Failed to update delivery' }); }
});

// ✅ NEW: Delete Delivery Route
app.delete('/deliveries/:id', authenticateToken, (req, res) => {
  try {
    const { id } = req.params;
    const index = deliveries.findIndex(d => d.id === id);
    if (index === -1) return res.status(404).json({ error: 'Delivery not found' });
    
    // Safety: Only allow deleting if it hasn't been assigned
    if (deliveries[index].status !== 'unassigned') {
      return res.status(400).json({ error: 'Cannot delete a delivery that has already been assigned.' });
    }

    deliveries.splice(index, 1);
    io.emit('delivery_update', { type: 'deleted', id });
    res.json({ message: 'Deleted successfully' });
  } catch (error) { res.status(500).json({ error: 'Failed to delete delivery' }); }
});

app.post('/deliveries/:id/accept', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { riderId } = req.body; 
  const delivery = deliveries.find(d => d.id === id);
  const rider = riders.find(r => r.id === riderId);
  
  if (!delivery || delivery.status !== 'unassigned') return res.status(400).json({ error: 'Delivery not available' });
  if (!rider) return res.status(400).json({ error: 'Rider not found' });
  if (!rider.available) return res.status(400).json({ error: 'Rider is busy' });
  
  delivery.status = 'assigned';
  delivery.assignedRiderId = riderId;
  rider.available = false;
  
  io.emit('delivery_update', { type: 'accepted', delivery, riderStatus: riders });
  res.json({ message: 'Accepted', delivery });
});

app.post('/deliveries/:id/pickup', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { pickupCode } = req.body;
  const delivery = deliveries.find(d => d.id === id);
  if (!delivery || delivery.status !== 'assigned') return res.status(400).json({ error: 'Invalid status' });
  if (delivery.pickupCode !== pickupCode) return res.status(400).json({ error: 'Invalid pickup code' });
  delivery.status = 'picked_up';
  io.emit('delivery_update', { type: 'picked_up', delivery, riderStatus: riders });
  res.json({ message: 'Pickup confirmed', delivery });
});

app.post('/deliveries/:id/confirm', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { confirmationCode } = req.body;
  const delivery = deliveries.find(d => d.id === id);
  if (!delivery || delivery.status !== 'picked_up') return res.status(400).json({ error: 'Must be picked up first' });
  if (delivery.deliveryCode !== confirmationCode) return res.status(400).json({ error: 'Invalid delivery code' });
  
  delivery.status = 'delivered';
  if (delivery.assignedRiderId) {
    const rider = riders.find(r => r.id === delivery.assignedRiderId);
    if (rider) {
      rider.available = true;
      io.emit('rider_available', { riderId: rider.id, riderName: rider.name });
    }
  }
  io.emit('delivery_update', { type: 'confirmed', delivery, riderStatus: riders });
  res.json({ message: 'Completed', delivery });
});

setInterval(() => { io.emit('rider_status_update', riders); }, 5000);

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  socket.emit('rider_status_update', riders);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));