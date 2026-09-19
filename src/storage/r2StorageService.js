import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import env from '../config/environment.js';
import logger from '../common/logger.js';

let s3Client = null;

function getS3Client() {
  if (!s3Client) {
    if (!env.r2.accessKey || !env.r2.secretKey || !env.r2.endpoint) {
      throw new Error('Cloudflare R2 credentials are missing or incomplete in environment');
    }

    s3Client = new S3Client({
      region: 'auto',
      endpoint: env.r2.endpoint,
      credentials: {
        accessKeyId: env.r2.accessKey,
        secretAccessKey: env.r2.secretKey,
      },
    });
  }
  return s3Client;
}

/**
 * Upload an in-memory buffer directly to Cloudflare R2.
 * Consumes 0 bytes of local server disk storage.
 *
 * @param {Object} params
 * @param {Buffer} params.buffer - File buffer from multer.memoryStorage
 * @param {string} params.key - Object key (e.g. tenants/{tenantId}/chat/{uuid}-{cleanName})
 * @param {string} params.contentType - MIME type
 * @param {Object} [params.metadata] - Optional custom metadata
 * @returns {Promise<{ key: string, url: string, size: number, contentType: string }>}
 */
export async function uploadBuffer({ buffer, key, contentType, metadata = {} }) {
  const client = getS3Client();
  const bucket = env.r2.bucket;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    Metadata: metadata,
  });

  try {
    await client.send(command);
    const publicUrl = `${env.r2.publicUrl}/${key}`;
    logger.info({ bucket, key, size: buffer.length }, 'Successfully uploaded file to Cloudflare R2');
    return {
      key,
      url: publicUrl,
      size: buffer.length,
      contentType,
    };
  } catch (error) {
    logger.error({ error: error.message, bucket, key }, 'Failed to upload buffer to Cloudflare R2');
    throw error;
  }
}

/**
 * Delete a single object from Cloudflare R2.
 * @param {string} key - Object key in bucket
 */
export async function deleteObject(key) {
  const client = getS3Client();
  const bucket = env.r2.bucket;

  const command = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  try {
    await client.send(command);
    logger.info({ bucket, key }, 'Deleted object from Cloudflare R2');
    return true;
  } catch (error) {
    logger.error({ error: error.message, bucket, key }, 'Failed to delete object from Cloudflare R2');
    throw error;
  }
}

/**
 * Delete multiple objects from Cloudflare R2 in batches.
 * @param {string[]} keys - Array of object keys to delete
 */
export async function deleteObjects(keys) {
  if (!keys || keys.length === 0) return { deletedCount: 0 };
  const client = getS3Client();
  const bucket = env.r2.bucket;

  let deletedCount = 0;
  // S3 DeleteObjects max limit is 1000 keys per request
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000).map((k) => ({ Key: k }));
    const command = new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: batch,
        Quiet: true,
      },
    });

    try {
      const response = await client.send(command);
      const errors = response.Errors || [];
      if (errors.length > 0) {
        logger.warn({ errors }, 'Some objects could not be deleted from Cloudflare R2');
      }
      deletedCount += batch.length - errors.length;
    } catch (error) {
      logger.error({ error: error.message, bucket, batchCount: batch.length }, 'Failed to batch delete from Cloudflare R2');
    }
  }

  logger.info({ bucket, deletedCount, requestedCount: keys.length }, 'Completed batch deletion from Cloudflare R2');
  return { deletedCount };
}

export default {
  uploadBuffer,
  deleteObject,
  deleteObjects,
};
