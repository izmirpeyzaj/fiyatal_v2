const multer = require('multer');
const path = require('path');
const fs = require('fs');

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const ALLOWED_EXTENSIONS = [
    '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp',
    '.doc', '.docx', '.xls', '.xlsx', '.csv',
    '.dwg', '.dxf', '.zip', '.rar'
];

const ALLOWED_MIMETYPES = [
    'application/pdf',
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'application/zip', 'application/x-rar-compressed',
    'application/octet-stream'
];

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'public', 'uploads', 'attachments');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname).toLowerCase());
    }
});

function fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return cb(new Error(`Desteklenmeyen dosya turu: ${ext}`), false);
    }
    if (!ALLOWED_MIMETYPES.includes(file.mimetype)) {
        return cb(new Error(`Desteklenmeyen dosya formati: ${file.mimetype}`), false);
    }
    cb(null, true);
}

const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter
});

module.exports = { upload };
