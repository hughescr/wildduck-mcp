import { handle } from '@hono/aws-lambda';
import { createApp } from './app';
import { loadConfig } from './config';

loadConfig();
export const handler = handle(createApp());
