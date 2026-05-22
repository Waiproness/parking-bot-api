const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// เชื่อมต่อ Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ฟังก์ชันดึงข้อมูลจาก Supabase และแปลง Key ให้เข้ากับ Frontend เดิม
async function getParkingSpots() {
    const { data, error } = await supabase
        .from('parking_spots')
        .select('*')
        .order('id', { ascending: true });
    
    if (error) {
        console.error('Error fetching from Supabase:', error);
        return [];
    }

    // แปลง snake_case เป็น camelCase เพื่อไม่ให้หน้าเว็บเอ๋อ
    return data.map(spot => ({
        id: spot.id,
        floor: spot.floor,
        spotNumber: spot.spot_number,
        status: spot.status,
        bookedBy: spot.booked_by,
        sessionId: spot.session_id
    }));
}

// ตรวจสอบและสร้างข้อมูลตั้งต้น 20 ช่องหากในระบบยังไม่มีข้อมูล (เปิดรันครั้งแรก)
async function initDatabase() {
    try {
        const spots = await getParkingSpots();
        if (spots.length === 0) {
            console.log('🔄 Initializing 20 parking spots in Supabase...');
            const initialSpots = Array.from({ length: 20 }, (_, i) => ({
                id: i + 1,
                floor: i < 10 ? 1 : 2,
                spot_number: (i % 10) + 1,
                status: 'empty',
                booked_by: null,
                session_id: null
            }));
            const { error } = await supabase.from('parking_spots').insert(initialSpots);
            if (error) console.error('❌ Init database failed:', error);
            else console.log('✅ 20 parking spots created successfully!');
        }
    } catch (e) {
        console.error(e);
    }
}
initDatabase();

// ------------------- API ENDPOINTS -------------------

// GET: สำหรับดึง JSON ทั้งหมดไปทดสอบ
app.get('/api/parking', async (req, res) => {
    const spots = await getParkingSpots();
    const available = spots.filter(s => s.status === 'empty').length;
    res.json({
        success: true,
        total_spots: 20,
        available_spots: available,
        data: spots
    });
});

// POST: สำหรับฟอร์มหน้าทดสอบ API จองที่จอดรถ
app.post('/api/parking/book', async (req, res) => {
    const { nickname, floor, spot_number } = req.body;

    if (!nickname || !floor || !spot_number) {
        return res.status(400).json({ success: false, error: 'ข้อมูลไม่ครบถ้วน' });
    }

    // ค้นหาตำแหน่งช่องจอด
    const { data: spot, error } = await supabase
        .from('parking_spots')
        .select('*')
        .eq('floor', floor)
        .eq('spot_number', spot_number)
        .single();

    if (error || !spot) {
        return res.status(404).json({ success: false, error: 'ไม่พบช่องจอดนี้' });
    }

    if (spot.status !== 'empty') {
        return res.status(400).json({ success: false, error: 'ช่องไม่ว่าง' });
    }

    // อัปเดตข้อมูลลง Supabase
    const { error: updateError } = await supabase
        .from('parking_spots')
        .update({ status: 'occupied', booked_by: nickname, session_id: 'api-test-session' })
        .eq('id', spot.id);

    if (updateError) {
        return res.status(500).json({ success: false, error: 'ไม่สามารถบันทึกข้อมูลได้' });
    }

    // ส่งสัญญาณ Real-time บอกทุกคนที่เปิดหน้าเว็บหลักอยู่
    const updatedSpots = await getParkingSpots();
    io.emit('updateSpots', updatedSpots);

    res.json({
        success: true,
        message: 'จองสำเร็จ',
        spot: updatedSpots.find(s => s.id === spot.id)
    });
});

// ------------------- WEB SOCKETS (REAL-TIME UI) -------------------
io.on('connection', async (socket) => {
    // ส่งข้อมูลล่าสุดให้คนที่เพิ่งเปิดเว็บเข้ามา
    const currentSpots = await getParkingSpots();
    socket.emit('updateSpots', currentSpots);

    // รับคำขอจองจากหน้าเว็บหลัก
    socket.on('bookSpot', async ({ id, name, sessionId }) => {
        const { error } = await supabase
            .from('parking_spots')
            .update({ status: 'occupied', booked_by: name, session_id: sessionId })
            .eq('id', id)
            .eq('status', 'empty'); // ป้องกันการกดจองซ้ำซ้อนในเสี้ยววินาทีเดียวกัน

        if (!error) {
            const updatedSpots = await getParkingSpots();
            io.emit('updateSpots', updatedSpots); // ยิงอัปเดตไปให้ทุกคน
        }
    });

    // รับคำขอยกเลิกจากหน้าเว็บหลัก
    socket.on('cancelSpot', async ({ id, sessionId }) => {
        const { error } = await supabase
            .from('parking_spots')
            .update({ status: 'empty', booked_by: null, session_id: null })
            .eq('id', id)
            .eq('session_id', sessionId); // ป้องกันคนอื่นมาสั่งลบแทนเจ้าของสิทธิ์

        if (!error) {
            const updatedSpots = await getParkingSpots();
            io.emit('updateSpots', updatedSpots); // ยิงอัปเดตไปให้ทุกคน
        }
    });
});

server.listen(3001, () => {
    console.log('🚀 Backend Server connected to Supabase and running on http://localhost:3001');
});