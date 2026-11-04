// Loaded with --import before any test module, because the config module
// validates required variables when it is first imported.
process.env.NODE_ENV ??= 'test';
process.env.JWT_SECRET ??= 'test-secret-used-only-by-the-chat-test-suite-0123456789';
process.env.JWT_ISSUER ??= 'lms-backend';
process.env.LMS_BACKEND_URL ??= 'http://backend.invalid';
process.env.SERVICE_KEY_SECRET ??= 'test-service-key-0123456789abcdef0123';
process.env.LOG_LEVEL ??= 'silent';
