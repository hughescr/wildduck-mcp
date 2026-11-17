import { isDeepStrictEqual } from 'node:util';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoSender } from '../src/auth/dynamo-store';

/** A DynamoDB model for the mail store: strong Gets, and transactions that apply all items or none, with the store's two
 * condition forms (item absent; record equal to :before) and ClientRequestToken idempotency. Faults are injectable. */
export class ModelSender implements DynamoSender {
    readonly records = new Map<string, Record<string, unknown>>();
    readonly calls: (GetCommand | TransactWriteCommand)[] = [];
    readonly committed = new Map<string, string>();
    fault: 'none' | 'lost_once' | 'unknown_always' | 'lost_persistent' = 'none';
    beforeTransaction: (() => void) | undefined;
    /** Errors thrown by the next calls of each kind, before the command is applied (throttles, conflicts). */
    readonly failures: { get: unknown[]; transact: unknown[] } = { get: [], transact: [] };
    async send(command: GetCommand | TransactWriteCommand): Promise<unknown> {
        this.calls.push(command);
        const failure = (command instanceof GetCommand ? this.failures.get : this.failures.transact).shift();
        if (failure !== undefined) { throw failure; }
        if (command instanceof GetCommand) { return { Item: structuredClone(this.records.get(String(command.input.Key?.pk))) }; }
        if (this.fault === 'unknown_always') { throw new Error('ambiguous socket outcome'); }
        const token = String(command.input.ClientRequestToken); const payload = JSON.stringify(command.input.TransactItems);
        const prior = this.committed.get(token);
        if (prior !== undefined) { if (prior !== payload) { throw new Error('idempotency mismatch'); } if (this.fault === 'lost_persistent') { throw new Error('lost commit acknowledgement'); } return {}; }
        this.beforeTransaction?.(); this.beforeTransaction = undefined;
        const items = command.input.TransactItems ?? [];
        const reasons = items.map(item => {
            const action = item.Put ?? item.Delete;
            const pk = String(item.Put?.Item?.pk ?? item.Delete?.Key?.pk);
            const stored = this.records.get(pk);
            const passed = action?.ConditionExpression === 'attribute_not_exists(#pk)' ? !stored : isDeepStrictEqual(stored?.record, action?.ExpressionAttributeValues?.[':before']);
            return { Code: passed ? 'None' : 'ConditionalCheckFailed' };
        });
        if (reasons.some(reason => reason.Code !== 'None')) { throw { name: 'TransactionCanceledException', CancellationReasons: reasons }; }
        for (const item of items) {
            if (item.Put?.Item) { this.records.set(String(item.Put.Item.pk), structuredClone(item.Put.Item)); }
            if (item.Delete?.Key) { this.records.delete(String(item.Delete.Key.pk)); }
        }
        this.committed.set(token, payload);
        if (this.fault === 'lost_persistent') { throw new Error('committed but acknowledgement unavailable'); }
        if (this.fault === 'lost_once') { this.fault = 'none'; throw new Error('response lost after commit'); }
        return {};
    }
}
