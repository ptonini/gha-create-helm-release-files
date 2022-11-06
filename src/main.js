require('dotenv').config();

const core = require('@actions/core');
const fs = require('fs');
const github = require('@actions/github');
const process = require("process");
const yaml = require("yaml")
const config = require('./config.js');
const octokit = github.getOctokit(core.getInput('github_token'))


async function getReleaseData(repo, ref) {
    const {data: {content: manifestContent}} = await octokit['rest'].repos.getContent({
        owner: repo.owner.login,
        repo: repo.name,
        path: config.manifestFile,
        ref: ref
    })
    const {data: {content: rpManifestContent}} = await octokit['rest'].repos.getContent({
        owner: repo.owner.login,
        repo: repo.name,
        path: config.rpManifestFile,
        ref: ref
    })
    const manifest = yaml.parse(Buffer.from(manifestContent, 'base64').toString('utf-8'))
    const {'.': version} = yaml.parse(Buffer.from(rpManifestContent, 'base64').toString('utf-8'))
    const parameters = {
        RELEASE_NAME: manifest['helm']['release_name'],
        CHART: manifest['helm']['chart'],
        CHART_VERSION: manifest['helm']['chart_version'],
        REPOSITORY: manifest['helm']['repository']
    }
    return {manifest: manifest, parameters: parameters, version: version}
}

function saveReleaseData(parameters, values, environment) {
    fs.mkdirSync(parameters.RELEASE_NAME, {recursive: true})
    let valuesFileContent = JSON.stringify(values, null, 2)
    let parametersFile = fs.createWriteStream(`${parameters.RELEASE_NAME}/parameters`)
    valuesFileContent = valuesFileContent.replace(/%ENVIRONMENT%/g, environment)
    fs.writeFileSync(`${parameters.RELEASE_NAME}/values`, valuesFileContent);
    Object.keys(parameters).forEach(p => {
        parametersFile.write(`${p}=${parameters[p]}\n`)
    })
}

async function main() {

    const event = yaml.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf-8'))
    const eventName = process.env.GITHUB_EVENT_NAME
    const owner = process.env.GITHUB_REPOSITORY_OWNER
    let releases = []
    let message = ''

    if (['workflow_dispatch', 'push'].includes(eventName)) {
        const {data: repo} = await octokit['rest'].repos.get({owner: owner, repo: event.repository.name})
        const {manifest: manifest, parameters: parameters, version: version} = await getReleaseData(repo)
        manifest['helm']['values']['image']['tag'] = version
        releases.push(manifest['helm']['release_name'])
        saveReleaseData(parameters, manifest['helm']['values'], process.env.ENVIRONMENT)
    }

    if (eventName === 'pull_request') {

        const appGroup = process.env.APP_GROUP
        const environment = process.env.ENVIRONMENT
        const ingressPath = process.env.INGRESS_PATH
        const orgDomain = core.getInput('org_domain')
        const headRef = process.env.GITHUB_HEAD_REF
        let ingresses = new Set()
        let repos
        let releaseName


        if (appGroup) {
            const res = await octokit['rest'].search.repos({q: `${appGroup} in:topics org:${owner}`})
            repos = res['data']['items']
        } else {
            const res = await octokit['rest'].repos.get({owner: owner, repo: event.repository.name})
            repos = [res['data']]
        }

        for (const repo of repos) {
            let data
            if (repo.full_name === event.repository.full_name) {
                data = await getReleaseData(repo, headRef)
                data.manifest['helm']['values']['image']['checksum'] = core.getInput('checksum')
                releaseName = data.manifest['helm']['release_name']
            } else {
                data = await getReleaseData(repo)
                data.manifest['helm']['values']['image']['tag'] = data.version
            }
            try {
                ingresses.add(data.manifest['helm']['values']['service']['labels']['ingress'])
            } catch {
            }
            releases.push(data.manifest['helm']['release_name'])
            saveReleaseData(data.parameters, data.manifest['helm']['values'], environment)
        }

        for (const i of ingresses) {
            const {data: {content: pContent}} = await octokit['rest'].repos.getContent({
                owner: owner,
                repo: config.ingressConfigsRepository,
                path: `${ingressPath}/${i}/parameters`
            })
            const {data: {content: vContent}} = await octokit['rest'].repos.getContent({
                owner: owner,
                repo: config.ingressConfigsRepository,
                path: `${ingressPath}/${i}/values`
            })
            const values = yaml.parse(Buffer.from(vContent, 'base64').toString('utf-8'))
            const parameters = {};
            Buffer.from(pContent, 'base64')
                .toString('utf-8')
                .split('\n')
                .filter(n => n)
                .forEach(line => {
                parameters[line.split('=')[0]] = line.split('=')[1]
            })
            values.data.hostname = `${i}.${event.number}.${releaseName}.${environment}.${orgDomain}`
            releases.push(parameters.RELEASE_NAME)
            saveReleaseData(parameters, values, environment)
            message += `https://${values.data.hostname}\n`
        }

    }

    core.setOutput('releases', releases.join(' '))
    core.setOutput('message', message)

}

main().catch(err => core.setFailed(err));