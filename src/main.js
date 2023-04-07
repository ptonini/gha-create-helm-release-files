require('dotenv-expand').expand(require('dotenv').config())

const core = require('@actions/core');
const fs = require('fs');
const octokit = require('@actions/github').getOctokit(core.getInput('github_token'))
const process = require("process");
const yaml = require("yaml")


async function getReleaseData(owner, repo, ref) {
    core.info(`fetching ${owner}/${repo} manifests`)
    try {
        const {data: {content: manifestContent}} = await octokit['rest'].repos.getContent({
            owner: owner,
            repo: repo,
            path: core.getInput('manifest_file'),
            ref: ref
        })
        const {data: {content: rpManifestContent}} = await octokit['rest'].repos.getContent({
            owner: owner,
            repo: repo,
            path: core.getInput('rp_manifest_file'),
            ref: ref
        })
        const manifest = yaml.parse(Buffer.from(manifestContent, 'base64').toString('utf-8'))
        const {'.': version} = yaml.parse(Buffer.from(rpManifestContent, 'base64').toString('utf-8'))
        const parameters = {
            RELEASE_NAME: manifest['helm']['release_name'],
            CHART: manifest['helm']['chart'],
            CHART_VERSION: manifest['helm']['chart_version'],
            REPOSITORY: manifest['helm']['repository'],
            NAMESPACE: manifest['helm']['namespace']
        }
        return {manifest: manifest, parameters: parameters, version: version}
    } catch (e) {
        core.setFailed(e)
    }
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
    const ref = process.env.GITHUB_HEAD_REF ? process.env.GITHUB_HEAD_REF : undefined
    const {data: repo} = await octokit['rest'].repos.get({owner: owner, repo: event.repository.name})
    const {manifest: manifest, parameters: parameters, version: version} = await getReleaseData(owner, repo.name, ref)
    const releaseName = manifest['helm']['release_name']

    const digest = core.getInput('digest')
    const orgDomain = core.getInput('org_domain')
    const appGroups = yaml.parse(core.getInput('app_groups')) ?? []
    const ingressConfigsRepository = core.getInput('ingress_configs_repository')

    const namespace = core.getInput('namespace') ? core.getInput('namespace').replace(/_/g, '-') : manifest['helm']['namespace']
    const environment = core.getInput('environment') ? core.getInput('environment') : manifest['environment']

    let releases = [releaseName]
    let hostnames = []
    manifest['helm']['values']['image']['digest'] = digest
    manifest['helm']['values']['image']['tag'] = digest ? null : version
    const defaultParams = {NAMESPACE: namespace, EXTRA_ARGS: eventName === 'pull_request' ? '--create-namespace' : ''}
    saveReleaseData({...parameters,...defaultParams}, manifest['helm']['values'], environment)

    if (eventName === 'pull_request') {

        const memberOf = appGroups.filter(v => event.repository.topics.includes(v));
        let message = `namespace: ${namespace}\n`
        let ingresses = new Set([manifest['helm'].values?.service?.labels?.ingress])

        if (memberOf.length > 0) {
            const {data: {items: repos}} = await octokit['rest'].search.repos({q: `${memberOf.join(" ")} in:topics org:${owner}`})
            for (const r of repos) if (r.full_name !== event.repository.full_name) {
                const data = await getReleaseData(r.owner.login, r.name)
                if (data !== undefined ) {
                    data.manifest['helm']['values']['image']['tag'] = data.version
                    ingresses.add(data.manifest['helm'].values?.service?.labels?.ingress)
                    releases.push(data.manifest['helm']['release_name'])
                    saveReleaseData({...data.parameters,...defaultParams}, data.manifest['helm']['values'], environment)
                }
            }
        }

        for (const i of ingresses) if (i) {
            core.info(`fetching ${i} ingress from ${owner}/${ingressConfigsRepository}`)
            const {data: {content: pContent}} = await octokit['rest'].repos.getContent({
                owner: owner,
                repo: ingressConfigsRepository,
                path: `${manifest['environment']}/${manifest['helm']['namespace']}/${i}/parameters`
            })
            const {data: {content: vContent}} = await octokit['rest'].repos.getContent({
                owner: owner,
                repo: ingressConfigsRepository,
                path: `${manifest['environment']}/${manifest['helm']['namespace']}/${i}/values`
            })
            const values = yaml.parse(Buffer.from(vContent, 'base64').toString('utf-8'))
            const parameters = {...defaultParams};
            Buffer.from(pContent, 'base64')
                .toString('utf-8')
                .split('\n')
                .filter(n => n)
                .forEach(line => {
                    parameters[line.split('=')[0]] = line.split('=')[1]
                })
            values.data.hostname = `${i}.${event.number}.${releaseName}.${environment}.${orgDomain}`
            releases.push(parameters.RELEASE_NAME)
            hostnames.push(values.data.hostname)
            saveReleaseData(parameters, values, environment)
            message += `${i}: https://${values.data.hostname}\n`
        }

        core.setOutput('message', message)

    }

    core.setOutput('releases', releases.join(' '))
    core.setOutput('hostnames', JSON.stringify(hostnames))

}

main().catch(err => core.setFailed(err));