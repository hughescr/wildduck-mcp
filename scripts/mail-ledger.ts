/**
 * Admin tool for the mail write ledger (see scripts/mail-ledger-core.ts for the rules and the usage text).
 * Run by hand on a machine with your own AWS credentials: bun scripts/mail-ledger.ts <command>
 * The Lambda's runtime role cannot Scan, and this script is the only thing that does.
 */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_PACING, GUARD_PK_PREFIX, OPERATION_PK_PREFIX, runLedger, type LedgerClient } from './mail-ledger-core';

/** The thin AWS layer: one SDK call per method, no decisions. maxAttempts 1 so the script's own paced retry is the only retry. */
export function dynamoLedgerClient(options: { table: string; region: string }): LedgerClient {
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: options.region, maxAttempts: 1 }));
    const TableName = options.table;
    const conditionFailed = (error: unknown): boolean => error instanceof ConditionalCheckFailedException || (error instanceof Error && error.name === 'ConditionalCheckFailedException');
    return {
        async scanPage(startKey, limit) {
            const result = await client.send(new ScanCommand({
                TableName,
                Limit: limit,
                ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
                FilterExpression: 'begins_with(#pk, :operation) OR begins_with(#pk, :guard)',
                ExpressionAttributeNames: { '#pk': 'pk' },
                ExpressionAttributeValues: { ':operation': OPERATION_PK_PREFIX, ':guard': GUARD_PK_PREFIX },
                ConsistentRead: false,
            }));
            return { items: result.Items ?? [], lastKey: result.LastEvaluatedKey };
        },
        async getItem(key) {
            const result = await client.send(new GetCommand({ TableName, Key: key, ConsistentRead: true }));
            return result.Item;
        },
        async setExpiresAt(key, expiresAt) {
            try {
                // attribute_exists(pk) stops an UpdateItem from creating an item that was deleted after the scan.
                await client.send(new UpdateCommand({
                    TableName,
                    Key: key,
                    UpdateExpression: 'SET #expiresAt = :expiresAt',
                    ConditionExpression: 'attribute_exists(#pk) AND attribute_not_exists(#expiresAt)',
                    ExpressionAttributeNames: { '#pk': 'pk', '#expiresAt': 'expiresAt' },
                    ExpressionAttributeValues: { ':expiresAt': expiresAt },
                }));
                return 'applied';
            } catch (error) { if (conditionFailed(error)) { return 'condition_failed'; } throw error; }
        },
        async deleteGuard(key, before) {
            try {
                // The store's own condition form: the whole record map must still equal what was read.
                await client.send(new DeleteCommand({
                    TableName,
                    Key: key,
                    ConditionExpression: '#record = :before',
                    ExpressionAttributeNames: { '#record': 'record' },
                    ExpressionAttributeValues: { ':before': before },
                }));
                return 'applied';
            } catch (error) { if (conditionFailed(error)) { return 'condition_failed'; } throw error; }
        },
    };
}

if (import.meta.main) {
    process.exitCode = await runLedger(process.argv.slice(2), {
        stdout: (value) => { process.stdout.write(value); },
        stderr: (value) => { process.stderr.write(value); },
    }, { makeClient: dynamoLedgerClient, nowMs: Date.now, pacing: DEFAULT_PACING });
}
