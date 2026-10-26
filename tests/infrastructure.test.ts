import { expect, test } from 'bun:test';

interface Infrastructure {
    provider: { runtime: string; memorySize: number; iam: { role: string } };
    resources: { Resources: Record<string, { Type: string; DeletionPolicy?: string; UpdateReplacePolicy?: string; Properties: Record<string, unknown> }> };
    functions: { api: { handler: string; url: boolean } };
    package: { artifact: string };
}

const configuration = Bun.YAML.parse(await Bun.file('serverless.yml').text()) as Infrastructure;

test('deployment keeps the agreed tiny footprint without hidden indexes or scaling resources', () => {
    expect(configuration.provider.runtime).toBe('nodejs26.x');
    expect(configuration.provider.memorySize).toBe(1024);
    expect(configuration.functions.api.url).toBe(true);
    expect(configuration.package.artifact).toBe('dist/function.zip');
    const resources = Object.values(configuration.resources.Resources);
    expect(resources.filter((resource) => resource.Type === 'AWS::DynamoDB::Table')).toHaveLength(1);
    expect(resources.some((resource) => resource.Type.startsWith('AWS::ApplicationAutoScaling::'))).toBe(false);
    const table = configuration.resources.Resources['CredentialTable'];
    expect(table?.Properties['ProvisionedThroughput']).toEqual({ ReadCapacityUnits: 1, WriteCapacityUnits: 1 });
    expect(table?.Properties['BillingMode']).toBe('PROVISIONED');
    expect(table?.Properties['GlobalSecondaryIndexes']).toBeUndefined();
    expect(table?.Properties['LocalSecondaryIndexes']).toBeUndefined();
    expect(table?.DeletionPolicy).toBe('Retain');
    expect(table?.UpdateReplacePolicy).toBe('Retain');
});
