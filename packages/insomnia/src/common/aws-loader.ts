import { GetParametersCommand, GetParametersCommandInput, SSMClient } from '@aws-sdk/client-ssm';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { Environment } from '../models/environment';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

const AWS_PREFIX = 'aws';

type EnvironmentData = {
  [key: string]: any;
};

type EnvironmentContent = {
  key: string;
  value: string;
};

type AwsProfile = {
  name: string;
  region: string;
};

function getFirstProfileAndRegion(): AwsProfile | null {
  const awsCredentialsPath = path.join(os.homedir(), '.aws', 'credentials');
  try {
    const credentialsFileContents = readFileSync(awsCredentialsPath, 'utf-8');
    const lines = credentialsFileContents.split(/\r?\n/);
    let currentProfile: string | null = null;

    for (let line of lines) {
      const profileMatch = line.match(/^\s*\[(.+?)\]\s*$/);
      if (profileMatch) {
        currentProfile = profileMatch[1];
        continue;
      }

      if (currentProfile) {
        const regionMatch = line.match(/^\s*region\s*=\s*(.+?)\s*$/);
        if (regionMatch) {
          return {
            name: currentProfile,
            region: regionMatch[1],
          };
        }
      }
    }
  } catch (error) {
    console.error('Error reading AWS credentials', error);
  }

  return null;
}

async function getAWSParameterValues(environmentContents: EnvironmentContent[]): Promise<Map<string, string>> {
  try {
    const awsPaths = environmentContents.map((path) => path.value.replace(AWS_PREFIX, ''));
    const awsProfile = getFirstProfileAndRegion();
    const ssm = new SSMClient({
      region: awsProfile?.region,
      credentials: fromIni({
        profile: awsProfile?.name,
      }),
    });
    const input: GetParametersCommandInput = {
      Names: awsPaths,
      WithDecryption: true,
    };
    const command = new GetParametersCommand(input);

    const response = await ssm.send(command);
    const environmentMap = new Map<string, string>();

    awsPaths.forEach((awsPath: string, index): void => {
      const awsParameter = response.Parameters?.find((p) => p.Name === awsPath);
      environmentMap.set(environmentContents[index].key, awsParameter?.Value ?? '');
    });

    return environmentMap;
  } catch (error) {
    console.error(`Failed to fetch values for paths ${environmentContents.join(', ')}: ${error}`);
    throw error;
  }
}

async function fetchAwsParameterValues(environmentData: EnvironmentData): Promise<Map<string, string>> {
  const awsPaths: EnvironmentContent[] = Object.entries(environmentData)
    .filter(([, value]) => typeof value === 'string' && value.includes(AWS_PREFIX))
    .map(([key, value]) => {
      return { key, value: value as string };
    });
  return await getAWSParameterValues(awsPaths);
}

function isAwsParameter(environmentData: EnvironmentData): boolean {
  const result = Object.entries(environmentData).filter(([, value]) => typeof value === 'string' && value.includes(AWS_PREFIX));
  return result.length > 0;
}

export async function updateEnvWithAWS(environment: Environment) {
  if (!isAwsParameter(environment.data)) {
    return;
  }
  const awsParameters = await fetchAwsParameterValues(environment.data);
  Object.entries(environment.data).forEach((env: EnvironmentData) => {
    const environmentKey = env[0];
    if (!awsParameters.has(environmentKey)) {
      return;
    }
    environment.data[environmentKey] = awsParameters.get(environmentKey);
  });
}
