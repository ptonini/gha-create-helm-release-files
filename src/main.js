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
        let manifest = yaml.parse(Buffer.from(manifestContent, 'base64').toString('utf-8'))
        manifest = 'helm' in manifest ? manifest.helm : manifest
        const {'.': version} = yaml.parse(Buffer.from(rpManifestContent, 'base64').toString('utf-8'))
        const parameters = {
            RELEASE_NAME: manifest['release_name'],
            CHART: manifest['chart'],
            CHART_VERSION: manifest['chart_version'],
            REPOSITORY: manifest['repository'],
            NAMESPACE: manifest['namespace']
        }
        return {manifest: manifest, parameters: parameters, version: version}
    } catch (e) {
        core.setFailed(e)
    }
}

function saveReleaseData(parameters, values, environment) {
    fs.mkdirSync(parameters.RELEASE_NAME, {recursive: true})
    let valuesFileContent= JSON.stringify(values, null, 2)
    let parametersFile= fs.createWriteStream(`${parameters.RELEASE_NAME}/parameters`)
    valuesFileContent = valuesFileContent.replace(/%ENVIRONMENT%/g, environment)
    fs.writeFileSync(`${parameters.RELEASE_NAME}/values`, valuesFileContent);
    Object.keys(parameters).forEach(p=> {
        parametersFile.write(`${p}=${parameters[p]}\n`)
    })
}

async function main() {

    const event = yaml.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf-8'))
    const isStaging= process.env.GITHUB_EVENT_NAME === "pull_request"
    const owner = process.env.GITHUB_REPOSITORY_OWNER
    const ref = process.env.GITHUB_HEAD_REF || undefined
    const {data: repo} = await octokit['rest'].repos.get({owner: owner, repo: event.repository.name})
    const {manifest: manifest, parameters: parameters, version: version} = await getReleaseData(owner, repo.name, ref)
    let releases = [manifest['release_name']]

    const digest = core.getInput('digest')
    const orgDomain = core.getInput('org_domain')
    const appGroups = yaml.parse(core.getInput('app_groups')) ?? []
    const ingressConfigsRepository = core.getInput('ingress_configs_repository')
    const environment = core.getInput('environment')
    const stagingEnvironment = core.getInput('staging_environment')
    const stagingNamespace = core.getInput('staging_namespace')


    if (isStaging) {
        manifest['values']['image']['digest'] = digest
        manifest['values']['replicas'] = 1
        const defaultParams = {NAMESPACE: stagingNamespace, EXTRA_ARGS: '--create-namespace'}
        saveReleaseData({...parameters,...defaultParams}, manifest['values'], stagingEnvironment)
        let message = `namespace: ${stagingNamespace}\n`
        let hostnames = []
        let ingresses = new Set([manifest.values?.service?.labels?.ingress])
        const memberOf = appGroups.filter(v => event.repository.topics.includes(v));
        if (memberOf.length > 0) {
            const {data: {items: repos}} = await octokit['rest'].search.repos({q: `${memberOf.join(" ")} in:topics org:${owner}`})
            for (const r of repos) if (r.full_name !== event.repository.full_name) {
                const data= await getReleaseData(r.owner.login, r.name)
                if (data !== undefined ) {
                    data.manifest['values']['image']['tag'] = data.version
                    data.manifest['values']['replicas'] = 1
                    ingresses.add(data.manifest.values?.service?.labels?.ingress)
                    releases.push(data.manifest['release_name'])
                    saveReleaseData({...data.parameters,...defaultParams}, data.manifest['values'], stagingEnvironment)
                }
            }
        }
        for (const i of ingresses) if (i) {
            core.info(`fetching ${i} ingress from ${owner}/${ingressConfigsRepository}`)
            const {data: {content: pContent}} = await octokit['rest'].repos.getContent({
                owner: owner,
                repo: ingressConfigsRepository,
                path: `${environment}/${manifest['namespace']}/${i}/parameters`
            })
            const {data: {content: vContent}} = await octokit['rest'].repos.getContent({
                owner: owner,
                repo: ingressConfigsRepository,
                path: `${environment}/${manifest['namespace']}/${i}/values`
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
            values.data.hostname = `${i}.${event.number}.${manifest['release_name']}.${stagingEnvironment}.${orgDomain}`
            releases.push(parameters.RELEASE_NAME)
            hostnames.push(values.data.hostname)
            saveReleaseData(parameters, values, stagingEnvironment)
            message += `${i}: https://${values.data.hostname}\n`
        }
        core.setOutput('message', message)
        core.setOutput('hostnames', JSON.stringify(hostnames))
    } else {
        manifest['values']['image']['tag'] = version
        saveReleaseData(parameters, manifest['values'], environment)
    }

    core.setOutput('releases', releases.join(' '))

}

main().catch(err => core.setFailed(err));