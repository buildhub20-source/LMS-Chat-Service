import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';

const uploadsDir = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${uuidv4()}${ext}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB
  },
});

const router = Router();

router.post('/', upload.array('files', 10), (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const fileInfos = req.files.map((f) => ({
      id: uuidv4(),
      name: f.originalname,
      originalName: f.originalname,
      filename: f.filename,
      url: `${baseUrl}/api/v1/chat/uploads/${f.filename}`,
      mimeType: f.mimetype,
      size: f.size,
    }));

    res.json({ success: true, data: fileInfos });
  } catch (err) {
    next(err);
  }
});

export { uploadsDir };
export default router;
