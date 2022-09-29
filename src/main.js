require('dotenv').config();

const core = require('@actions/core');
const fs = require('fs');
const github = require('@actions/github');
const process = require("process");
const yaml = require("yaml")
const octokit = github.getOctokit(core.getInput('github_token'))



async function getReleaseData(repo, ref) {
    const {data: {content: manifestContent}} = await octokit['rest'].repos.getContent({owner: repo.owner.login, repo: repo.name, path: process.env.MANIFEST_FILE, ref: ref})
    const {data: {content: rpManifestContent}} = await octokit['rest'].repos.getContent({owner: repo.owner.login, repo: repo.name, path:  process.env.RP_MANIFEST_FILE, ref: ref})
    const {'.': version} = yaml.parse(Buffer.from(rpManifestContent, 'base64').toString('utf-8'))
    const manifest = yaml.parse(Buffer.from(manifestContent, 'base64').toString('utf-8'))
    const parameters = {
        RELEASE_NAME: manifest['helm']['release_name'],
        CHART: manifest['helm']['chart'],
        CHART_VERSION: manifest['helm']['chart_version'],
        REPOSITORY: manifest['helm']['repository']
    }
    return {manifest: manifest, parameters: parameters, version: version}
}

async function saveReleaseData(parameters, values, environment) {
    fs.mkdirSync(parameters.RELEASE_NAME, { recursive: true })
    let valuesFileContent =  JSON.stringify(values, null, 2)
    let parametersFile = fs.createWriteStream(`${parameters.RELEASE_NAME}/parameters`)
    valuesFileContent = valuesFileContent.replace(/%ENVIRONMENT%/g, environment)
    fs.writeFileSync(`${parameters.RELEASE_NAME}/values`, valuesFileContent);
    Object.keys(parameters).forEach(p => {
        parametersFile.write(`${p}=${parameters[p]}\n`)
    })
}

async function main() {

    const event = yaml.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf-8'))
    const owner = process.env.GITHUB_REPOSITORY_OWNER
    let releases = []

    if (process.env.PROMOTE_CANDIDATE === 'true' || process.env.GITHUB_WORKFLOW === 'configure') {
        const {data: repo} = await octokit['rest'].repos.get({owner: owner, repo: event.repository.name})
        const {manifest: manifest, parameters: parameters, version: version} = await getReleaseData(repo)
        manifest['helm']['values']['image']['tag'] = version
        releases.push(manifest['helm']['release_name'])
        await saveReleaseData(parameters, manifest['helm']['values'], process.env.ENVIRONMENT)
    }

    if (process.env.CREATE_STAGING === 'true') {

        let ingresses = new Set()
        let imagePullSecrets = new Set()
        let repos
        if (process.env.PROJECT_APP) {
            const response = await octokit['rest'].search.repos({q: `${process.env.PROJECT_APP} in:topics org:${owner}`})
            repos = response['data']['items']
        } else {
            const {data: repo} = await octokit['rest'].repos.get({owner: owner, repo: event.repository.name})
            repos = [repo]
        }

        for (const repo of repos) {
            let data

            if (repo.full_name === process.env.GITHUB_REPOSITORY) {
                data = await getReleaseData(repo, process.env.GITHUB_HEAD_REF)
                data.manifest['helm']['values']['image']['checksum'] = core.getInput('checksum')
            } else {
                data = await getReleaseData(repo)
                data.manifest['helm']['values']['image']['tag'] = data.version
            }
            try {
                ingresses.add(data.manifest['helm']['values']['service']['labels']['ingress'])
            } catch {}
            try {
                data.manifest['helm']['values']['image_pull_secrets'].forEach(i => {imagePullSecrets.add(i)})
            } catch {}
            releases.push(data.manifest['helm']['release_name'])
            await saveReleaseData(data.parameters, data.manifest['helm']['values'], process.env.ENVIRONMENT)
        }

        for (const i of ingresses) {
            const ingressPath = `${process.env.PRD_ENVIRONMENT}/${process.env.PRD_NAMESPACE}/${i}`
            const repo = process.env.INGRESS_CONFIG_REPOSITORY
            const {data: {content: parametersContent}} = await octokit['rest'].repos.getContent({owner: owner, repo: repo, path: `${ingressPath}/parameters`})
            const {data: {content: valuesContent}} = await octokit['rest'].repos.getContent({owner: owner, repo: repo, path: `${ingressPath}/values`})
            const parameters = {};
            const values = yaml.parse(Buffer.from(valuesContent, 'base64').toString('utf-8'))
            Buffer.from(parametersContent, 'base64').toString('utf-8').split('\n').filter(n => n).forEach(line => {
                parameters[line.split('=')[0]] = line.split('=')[1]
            })
            values.data.domain = `${i}.${process.env.STAGING_DOMAIN}`
            releases.push(i)
            await saveReleaseData(parameters, values, process.env.ENVIRONMENT)
        }

        const parameters =  {
            RELEASE_NAME: 'ghcr-credentials',
            CHART: 'secret',
            CHART_VERSION: '^2.0.0',
            REPOSITORY: 'https://charts.nodis.com.br'
        }
        const values = {
            type: 'kubernetes.io/dockerconfigjson',
            plain_text : {'.dockerconfigjson': process.env.REGISTRY_CREDENTIALS}
        }
        releases.push(parameters.RELEASE_NAME)
        await saveReleaseData(parameters, values, process.env.ENVIRONMENT)

    }

    core.setOutput('releases', releases.join(' '))

}

main().catch(err => core.setFailed(err));