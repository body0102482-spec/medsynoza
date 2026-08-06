-- Add OpenRouter API key to AISettings (safe additive column).
ALTER TABLE `AISettings` ADD COLUMN `openRouterApiKey` TEXT NULL;
