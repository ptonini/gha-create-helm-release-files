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

function saveReleaseData(parameters, values, environment) {
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

    if (['workflow_dispatch', 'push'].includes(process.env.GITHUB_EVENT_NAME)) {
        const {data: repo} = await octokit['rest'].repos.get({owner: owner, repo: event.repository.name})
        const {manifest: manifest, parameters: parameters, version: version} = await getReleaseData(repo)
        manifest['helm']['values']['image']['tag'] = version
        releases.push(manifest['helm']['release_name'])
        saveReleaseData(parameters, manifest['helm']['values'], process.env.ENVIRONMENT)
    }

    if (process.env.GITHUB_EVENT_NAME === 'pull_request') {

        let ingresses = new Set()
        let imagePullSecrets = new Set()
        let repos
        if (process.env.APP_GROUP) {
            const response = await octokit['rest'].search.repos({q: `${process.env.APP_GROUP} in:topics org:${owner}`})
            repos = response['data']['items']
        } else {
            const response = await octokit['rest'].repos.get({owner: owner, repo: event.repository.name})
            repos = [response['data']]
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
            saveReleaseData(data.parameters, data.manifest['helm']['values'], process.env.ENVIRONMENT)
        }

        for (const i of ingresses) {
            const path = `${process.env.PRD_ENVIRONMENT}/${process.env.PRD_NAMESPACE}/${i}`
            const repo = process.env.INGRESS_CONFIG_REPOSITORY
            const {data: {content: pContent}} = await octokit['rest'].repos.getContent({owner: owner, repo: repo, path: `${path}/parameters`})
            const {data: {content: vContent}} = await octokit['rest'].repos.getContent({owner: owner, repo: repo, path: `${path}/values`})
            const parameters = {};
            const values = yaml.parse(Buffer.from(vContent, 'base64').toString('utf-8'))
            Buffer.from(pContent, 'base64').toString('utf-8').split('\n').filter(n => n).forEach(line => {
                parameters[line.split('=')[0]] = line.split('=')[1]
            })
            values.data.domain = `${i}.${process.env.STAGING_DOMAIN}`
            releases.push(parameters.RELEASE_NAME)
            saveReleaseData(parameters, values, process.env.ENVIRONMENT)
        }

        const parameters =  {
            RELEASE_NAME: process.env.IMAGE_PULL_SECRET,
            CHART: process.env.HELM_SECRET_CHART,
            CHART_VERSION: process.env.HELM_SECRET_CHART_VERSION,
            REPOSITORY: process.env.HELM_REPOSITORY
        }
        const values = {
            type: 'kubernetes.io/dockerconfigjson',
            plain_text : {'.dockerconfigjson': process.env.REGISTRY_CREDENTIALS}
        }
        releases.push(parameters.RELEASE_NAME)
        saveReleaseData(parameters, values, process.env.ENVIRONMENT)

    }

    core.setOutput('releases', releases.join(' '))

}

main().catch(err => core.setFailed(err));