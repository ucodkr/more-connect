import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DockerHost } from "../types";

const execFileAsync = promisify(execFile);

export type DockerCategory = "containers" | "images" | "volumes" | "networks";

export type DockerContainerInfo = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
};

export type DockerImageInfo = {
  id: string;
  repository: string;
  tag: string;
  size: string;
};

export type DockerVolumeInfo = {
  name: string;
  driver: string;
  scope: string;
};

export type DockerNetworkInfo = {
  id: string;
  name: string;
  driver: string;
  scope: string;
};

function dockerEnv(host: DockerHost): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DOCKER_HOST: host.host
  };
}

async function runDocker(host: DockerHost, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", ["--host", host.host, ...args], {
      env: dockerEnv(host),
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Docker host "${host.name}" failed: ${message}`);
  }
}

function parseJsonLines<T>(text: string): T[] {
  return text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export async function listDockerContainers(host: DockerHost): Promise<DockerContainerInfo[]> {
  const out = await runDocker(host, ["ps", "-a", "--format", "{{json .}}"]);
  return parseJsonLines<any>(out).map((item) => ({
    id: String(item.ID ?? ""),
    name: String(item.Names ?? ""),
    image: String(item.Image ?? ""),
    state: String(item.State ?? ""),
    status: String(item.Status ?? "")
  }));
}

export async function listDockerImages(host: DockerHost): Promise<DockerImageInfo[]> {
  const out = await runDocker(host, ["images", "--format", "{{json .}}"]);
  return parseJsonLines<any>(out).map((item) => ({
    id: String(item.ID ?? ""),
    repository: String(item.Repository ?? "<none>"),
    tag: String(item.Tag ?? "<none>"),
    size: String(item.Size ?? "")
  }));
}

export async function listDockerVolumes(host: DockerHost): Promise<DockerVolumeInfo[]> {
  const out = await runDocker(host, ["volume", "ls", "--format", "{{json .}}"]);
  return parseJsonLines<any>(out).map((item) => ({
    name: String(item.Name ?? ""),
    driver: String(item.Driver ?? ""),
    scope: String(item.Scope ?? "")
  }));
}

export async function listDockerNetworks(host: DockerHost): Promise<DockerNetworkInfo[]> {
  const out = await runDocker(host, ["network", "ls", "--format", "{{json .}}"]);
  return parseJsonLines<any>(out).map((item) => ({
    id: String(item.ID ?? ""),
    name: String(item.Name ?? ""),
    driver: String(item.Driver ?? ""),
    scope: String(item.Scope ?? "")
  }));
}

export async function startDockerContainer(host: DockerHost, containerId: string): Promise<void> {
  await runDocker(host, ["start", containerId]);
}

export async function stopDockerContainer(host: DockerHost, containerId: string): Promise<void> {
  await runDocker(host, ["stop", containerId]);
}

export async function removeDockerContainer(host: DockerHost, containerId: string): Promise<void> {
  await runDocker(host, ["rm", "-f", containerId]);
}

export async function removeDockerImage(host: DockerHost, imageId: string): Promise<void> {
  await runDocker(host, ["image", "rm", "-f", imageId]);
}
