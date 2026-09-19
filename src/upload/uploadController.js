import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { uploadBuffer } from '../storage/r2StorageService.js';
import logger from '../common/logger.js';

// In-memory storage only — 0 bytes stored on the local server disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB
  },
});

const router = Router();

router.post('/', upload.array('files', 10), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const tenantId = req.tenantId || 'global';
    const userId = req.user?.userId || 'unknown';

    const uploadPromises = req.files.map(async (file) => {
      const fileId = uuidv4();
      const ext = path.extname(file.originalname).toLowerCase();
      const baseName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9._-]/g, '_');
      const cleanFileName = `${baseName}${ext}`;
      const objectKey = `tenants/${tenantId}/chat/${fileId}-${cleanFileName}`;

      const r2Result = await uploadBuffer({
        buffer: file.buffer,
        key: objectKey,
        contentType: file.mimetype || 'application/octet-stream',
        metadata: {
          originalName: cleanFileName,
          tenantId: String(tenantId),
          uploaderId: String(userId),
        },
      });

      return {
        id: fileId,
        name: file.originalname,
        originalName: file.originalname,
        key: objectKey,
        url: r2Result.url,
        mimeType: file.mimetype,
        size: file.size,
      };
    });

    const fileInfos = await Promise.all(uploadPromises);

    logger.info({ tenantId, count: fileInfos.length }, 'Files uploaded to Cloudflare R2');
    res.json({ success: true, data: fileInfos });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed uploading chat files to Cloudflare R2');
    next(err);
  }
});

export default router;
