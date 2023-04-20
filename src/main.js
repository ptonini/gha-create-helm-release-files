require('dotenv-expand').expand(require('dotenv').config())
const core = require('@actions/core');
const fs = require('fs');
const process = require("process");
const yaml = require("yaml")
const {Octokit} = require("@octokit/rest")
const octokit = new Octokit({auth: core.getInput('github_token')})


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
        let stagingValues = {}
        let stagingGroup = []
        try {
            let resp = await octokit['rest'].actions['getRepoVariable']({
                owner: owner,
                repo: repo,
                name: 'staging_values'
            })
            stagingValues = yaml.parse(resp.data.value)
        } catch (e) {
        }
        try {
            let resp = await octokit['rest'].actions['getRepoVariable']({
                owner: owner,
                repo: repo,
                name: 'staging_group'
            })
            stagingGroup = yaml.parse(resp.data.value)
        } catch (e) {
        }
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
        return {
            manifest: manifest,
            parameters: parameters,
            version: version,
            stagingValues: stagingValues,
            stagingGroup: stagingGroup
        }
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
    const owner = process.env.GITHUB_REPOSITORY_OWNER
    const digest = core.getInput('digest')
    const orgDomain = core.getInput('org_domain')
    const ingressConfigsRepository = core.getInput('ingress_configs_repository')
    const environment = core.getInput('environment')
    const stagingEnvironment = core.getInput('staging_environment')
    const stagingNamespace = core.getInput('staging_namespace')
    const {
        manifest: manifest,
        parameters: parameters,
        version: version,
        stagingValues: stagingValues,
        stagingGroup: stagingGroup
    } = await getReleaseData(owner, event.repository.name, process.env.GITHUB_HEAD_REF || undefined)

    if (process.env.GITHUB_EVENT_NAME === "pull_request") {
        const stagingParameters = {NAMESPACE: stagingNamespace, EXTRA_ARGS: '--create-namespace'}
        let message = `namespace: ${stagingNamespace}\n`
        let hostnames = []
        let ingresses = new Set([manifest.values?.service?.labels?.ingress])
        manifest['values']['image']['digest'] = digest
        saveReleaseData({...parameters, ...stagingParameters}, {...manifest['values'], ...stagingValues}, stagingEnvironment)
        for (const member of stagingGroup) if (member !== event.repository.name) {
            const data = await getReleaseData(owner, member)
            data.manifest['values']['image']['tag'] = data.version
            saveReleaseData({...data.parameters, ...stagingParameters}, {...data.manifest['values'], ...data.stagingValues}, stagingEnvironment)
            ingresses.add(data.manifest.values?.service?.labels?.ingress)
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
            const parameters = {...stagingParameters};
            Buffer.from(pContent, 'base64')
                .toString('utf-8')
                .split('\n')
                .filter(n => n)
                .forEach(line => {
                    parameters[line.split('=')[0]] = line.split('=')[1]
                })
            values.data.hostname = `${i}.${event.number}.${manifest['release_name']}.${stagingEnvironment}.${orgDomain}`
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

}

main().catch(err => core.setFailed(err));