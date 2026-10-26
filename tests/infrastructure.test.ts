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

interface PolicyStatement {
    Action: string | string[];
    Resource: unknown;
}

interface Bootstrap {
    Resources: {
        GitHubDeployRole: {
            Properties: {
                Policies: { PolicyDocument: { Statement: PolicyStatement[] } }[];
            };
        };
    };
}

test('deployment can discover log groups without granting account-wide log mutations', async () => {
    const bootstrap = Bun.YAML.parse(await Bun.file('infra/bootstrap.yml').text()) as Bootstrap;
    const statements = bootstrap.Resources.GitHubDeployRole.Properties.Policies.flatMap((policy) => policy.PolicyDocument.Statement);
    const globalLogActions = statements.filter((statement) => statement.Resource === '*')
        .flatMap((statement) => typeof statement.Action === 'string' ? [statement.Action] : statement.Action)
        .filter((action) => action.startsWith('logs:'));
    expect(globalLogActions).toEqual(['logs:DescribeLogGroups']);
    const logMutations = statements.filter((statement) => Array.isArray(statement.Action) && statement.Action.includes('logs:*'));
    expect(logMutations).toHaveLength(1);
    expect(logMutations[0]?.Resource).toEqual([
        { 'Fn::Sub': 'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/wildduck-mcp-prod-api' },
        { 'Fn::Sub': 'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/wildduck-mcp-prod-api:*' },
    ]);
});

interface TrustDocument {
    Resources: {
        GitHubDeployRole: {
            Properties: {
                AssumeRolePolicyDocument: {
                    Statement: {
                        Action: string;
                        Condition: { StringEquals: Record<string, string> };
                    }[];
                };
            };
        };
    };
}

test('OIDC trust binds the actual immutable repository identity and main branch only', async () => {
    const bootstrap = Bun.YAML.parse(await Bun.file('infra/bootstrap.yml').text()) as TrustDocument;
    const trust = bootstrap.Resources.GitHubDeployRole.Properties.AssumeRolePolicyDocument.Statement;
    expect(trust).toHaveLength(1);
    expect(trust[0]?.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(trust[0]?.Condition).toEqual({
        StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': 'repo:hughescr@46348/wildduck-mcp@1434754693:ref:refs/heads/main',
        },
    });
});
type Resource = { Type: string; DeletionPolicy?: string; UpdateReplacePolicy?: string; Properties: Record<string, unknown> };
interface CloudFrontConfig {
    Aliases: unknown[]; ViewerCertificate: Record<string, unknown>; Origins: { DomainName: unknown; CustomOriginConfig: Record<string, unknown> }[];
    DefaultCacheBehavior: Record<string, unknown>; CacheBehaviors: Record<string, unknown>[];
    CustomErrorResponses: { ErrorCode: number; ErrorCachingMinTTL: number; ResponseCode?: number; ResponsePagePath?: string }[];
    WebACLId?: string;
}
const bootstrapCf = Bun.YAML.parse(await Bun.file('infra/bootstrap.yml').text()) as { Parameters: Record<string, Record<string, unknown>>; Resources: Record<string, Resource>; Outputs: Record<string, unknown> };
const cloudFront = bootstrapCf.Resources.PublicDistribution?.Properties.DistributionConfig as CloudFrontConfig;
test('CloudFront uses the approved shared certificate and DNS pattern with an independent canonical origin', async () => {
    expect(bootstrapCf.Parameters.PublicDomainName?.Default).toBe('wildduck-mcp.rungie.com');
    expect(bootstrapCf.Parameters.HostedZoneId?.Default).toBe('Z1VXUCOF8PCGCR');
    expect(cloudFront.Aliases).toEqual([{ Ref: 'PublicDomainName' }]);
    expect(cloudFront.ViewerCertificate).toEqual({ AcmCertificateArn: { Ref: 'SSLCertificate' }, SslSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' });
    const certificate = bootstrapCf.Resources.SSLCertificate;
    expect(certificate?.Type).toBe('Custom::DNSCertificate'); expect(certificate?.Properties.Region).toBe('us-east-1');
    expect(certificate?.Properties.ServiceToken).toEqual({ 'Fn::ImportValue': 'CertificateAccepterLambda-Arn' });
    expect(certificate?.DeletionPolicy).toBe('Retain'); expect(certificate?.UpdateReplacePolicy).toBe('Retain');
    for (const [name, type] of [['PublicDnsA', 'A'], ['PublicDnsAAAA', 'AAAA']]) {
        const dns = bootstrapCf.Resources[name ?? '']; expect(dns?.Properties.Type).toBe(type);
        expect(dns?.Properties.Name).toEqual({ Ref: 'PublicDomainName' }); expect(dns?.Properties.HostedZoneId).toEqual({ Ref: 'HostedZoneId' });
        expect(dns?.Properties.AliasTarget).toEqual({ DNSName: { 'Fn::GetAtt': ['PublicDistribution', 'DomainName'] }, HostedZoneId: 'Z2FDTNDATAQYW2' });
    }
    const source = Bun.YAML.parse(await Bun.file('serverless.yml').text()) as { provider: { environment: Record<string, unknown> } };
    expect(source.provider.environment.PUBLIC_BASE_URL).toEqual({ 'Fn::ImportValue': 'wildduck-mcp-prod-public-origin' });
    expect(bootstrapCf.Outputs.PublicBaseUrl).toEqual({ Value: { 'Fn::Sub': 'https://${PublicDomainName}' }, Export: { Name: 'wildduck-mcp-prod-public-origin' } });
    expect(JSON.stringify(bootstrapCf)).not.toContain('Fn::ImportValue":"ApiLambdaFunction');
});
test('all OAuth ingress paths disable caching and forward auth, cookies, origin and query metadata', () => {
    expect(cloudFront.Origins).toHaveLength(1);
    expect(cloudFront.Origins[0]?.DomainName).toEqual({ 'Fn::Select': [2, { 'Fn::Split': ['/', { Ref: 'FunctionUrlOrigin' }] }] });
    expect(cloudFront.Origins[0]?.CustomOriginConfig).toEqual({ OriginProtocolPolicy: 'https-only', OriginSSLProtocols: ['TLSv1.2'] });
    expect(cloudFront.CacheBehaviors.map(behavior => behavior.PathPattern)).toEqual(['/token', '/revoke']);
    for (const behavior of [cloudFront.DefaultCacheBehavior, ...cloudFront.CacheBehaviors]) {
        expect(behavior.AllowedMethods).toEqual(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']);
        expect(behavior.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
        expect(behavior.OriginRequestPolicyId).toBe('b689b0a8-53d0-40ab-baf2-68738e2966ac');
        expect(behavior.ViewerProtocolPolicy).toBe('https-only'); expect(behavior.FunctionAssociations).toBeUndefined(); expect(behavior.LambdaFunctionAssociations).toBeUndefined();
    }
    const supportedErrors = [400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504];
    expect(cloudFront.CustomErrorResponses.map(error => error.ErrorCode)).toEqual(supportedErrors);
    for (const error of cloudFront.CustomErrorResponses) { expect(error.ErrorCachingMinTTL).toBe(0); expect(error.ResponseCode).toBeUndefined(); expect(error.ResponsePagePath).toBeUndefined(); }
});
test('edge policies restore real challenge headers without overriding origin security headers or granting CI CloudFront control', () => {
    expect(cloudFront.DefaultCacheBehavior.ResponseHeadersPolicyId).toEqual({ Ref: 'BearerResponseHeaders' });
    for (const behavior of cloudFront.CacheBehaviors) { expect(behavior.ResponseHeadersPolicyId).toEqual({ Ref: 'BasicResponseHeaders' }); }
    const header = (name: string) => bootstrapCf.Resources[name]?.Properties.ResponseHeadersPolicyConfig as { CustomHeadersConfig: { Items: unknown[] }; SecurityHeadersConfig?: unknown; CorsConfig?: unknown };
    expect(header('BearerResponseHeaders').CustomHeadersConfig.Items).toEqual([{ Header: 'WWW-Authenticate', Value: { 'Fn::Sub': 'Bearer resource_metadata="https://${PublicDomainName}/.well-known/oauth-protected-resource/mcp"' }, Override: false }]);
    expect(header('BasicResponseHeaders').CustomHeadersConfig.Items).toEqual([{ Header: 'WWW-Authenticate', Value: 'Basic realm="oauth"', Override: false }]);
    for (const name of ['BearerResponseHeaders', 'BasicResponseHeaders']) { expect(header(name).SecurityHeadersConfig).toBeUndefined(); expect(header(name).CorsConfig).toBeUndefined(); }
    expect(Object.values(bootstrapCf.Resources).filter(resource => resource.Type === 'AWS::CloudFront::ResponseHeadersPolicy')).toHaveLength(2);
    expect(Object.values(bootstrapCf.Resources).some(resource => /AWS::(?:ApiGateway|WAF|CloudFront::Function)/.test(resource.Type))).toBe(false);
    const role = JSON.stringify(bootstrapCf.Resources.GitHubDeployRole); expect(role).not.toContain('cloudfront:'); expect(role).not.toContain('apigateway:'); expect(role).not.toContain('CertificateAccepterLambda-Arn');
    expect(cloudFront.WebACLId).toBeUndefined();
});
