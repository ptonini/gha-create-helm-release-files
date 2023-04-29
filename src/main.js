require('dotenv-expand').expand(require('dotenv').config())
const fs = require('fs');
const yaml = require("yaml")
const core = require('@actions/core');
const {context} = require('@actions/github')
const {Octokit} = require("@octokit/rest")
const artifact = require('@actions/artifact');


// Inputs
const macros = yaml.parse(core.getInput('macros'))
const digest = core.getInput('digest')
const containerRegistry = core.getInput('container_registry')
const stagingDomain = core.getInput('staging_domain')
const manifestFile = core.getInput('manifest_file')
const rpManifestFile = core.getInput('rp_manifest_file')
const githubToken = core.getInput('github_token')
const ingressBotLabel = core.getInput('ingress_bot_label')
const ingressBotHostAnnotation = core.getInput('ingress_bot_host_annotation')
const ingressBotPathAnnotation = core.getInput('ingress_bot_path_annotation')


// Global values
const workspace = process.env.GITHUB_WORKSPACE
const octokit = new Octokit({auth: githubToken})
const artifactClient = artifact.create()
const outputName = 'releases'
const releaseFiles = []
const releasePaths = []


async function getManifests(owner, repo, ref) {


    let values, parameters, version
    core.debug(`fetching ${owner}/${repo} manifests`)

    // Fetch helm manifest
    try {
        const path = manifestFile
        const {data: {content: content}} = await octokit.rest.repos.getContent({owner, repo, ref, path})
        let manifestStr, manifest
        manifestStr = Buffer.from(content, 'base64').toString('utf-8')
        macros.forEach(macro => manifestStr = manifestStr.replaceAll(`%${macro.name}%`, macro.value))
        manifest = yaml.parse(manifestStr)
        manifest = 'helm' in manifest ? manifest.helm : manifest
        values = manifest.values
        // Fetch staging values
        if (context.eventName === "pull_request") {
            try {
                const name = 'staging_values'
                const {data: {value: value}} = await octokit.rest.actions['getRepoVariable']({owner, repo, name})
                values = {...values, ...yaml.parse(value)}
            } catch (e) {
                core.warning(`${repo} staging values are not usable [${e}]`)
            }
        }
        delete manifest.values
        parameters = manifest
    } catch (e) {
        core.setFailed(`${repo} helm manifest not found [${e}]`)
    }

    // Fetch release-please manifest
    try {
        const path = rpManifestFile
        const {data: {content: content}} = await octokit.rest.repos.getContent({owner, repo, ref, path});
        ({'.': version} = yaml.parse(Buffer.from(content, 'base64').toString('utf-8')))
    } catch (e) {
        core.setFailed(`${repo} release-please manifest not found [${e}]`)
    }

    return {values, parameters, version}

}

function createReleaseFiles(values, parameters) {

    // Create release folder
    const releasePath = `${workspace}/${parameters['release_name']}`
    fs.mkdirSync(releasePath, {recursive: true})
    releasePaths.push(releasePath)

    // Write values to file
    core.debug(`creating ${releasePath}/values`)
    fs.writeFileSync(`${releasePath}/values`, JSON.stringify(values, null, 2));
    releaseFiles.push(`${releasePath}/values`)

    // Write parameters to file
    core.debug(`creating ${releasePath}/parameters`)
    let parametersFileString = ''
    Object.keys(parameters).forEach(p => parametersFileString += `${p.toUpperCase()}=${parameters[p]}\n`)
    fs.writeFileSync(`${releasePath}/parameters`, parametersFileString)
    releaseFiles.push(`${releasePath}/parameters`)

}

async function main() {

    const {owner, repo} = context.repo
    const {values, parameters, version} = await getManifests(owner, repo, context.payload.pull_request?.head.ref)

    if (['push', 'workflow_dispatch'].includes(context.eventName)) {

        // Prepare production deploy
        values.image = `${containerRegistry}/${repo}:${version}`
        await createReleaseFiles(values, parameters)

    } else if (context.eventName === "pull_request") {

        // Prepare staging deploy
        const stagingNamespace = `${repo.replaceAll('_', '-')}-${context.payload.number}`
        const stagingHost = `${stagingNamespace}.${stagingDomain}`

        values.image = digest ? `${containerRegistry}/${repo}@${digest}` : `${containerRegistry}/${repo}:${version}`
        const stagingReleases = [{values, parameters}]
        let message = `namespace: ${stagingNamespace}`

        // Fetch staging group members
        try {
            core.debug(`fetching ${owner}/${repo} staging group`)
            const name = 'staging_group';
            const {data: {value: value}} = await octokit.rest.actions['getRepoVariable']({owner, repo, name})
            for (const member of yaml.parse(value).filter(member => member !== repo)) {
                const {values, parameters, version} = await getManifests(owner, member)
                values.image = `${containerRegistry}/${member}:${version}`
                stagingReleases.push({values, parameters})
            }
        } catch (e) {
            core.debug(`${repo} staging group is not usable [${e}]`)
        }

        // Save release files
        for (const release of stagingReleases) {
            let {values, parameters} = release
            parameters = {...parameters, ...{namespace: stagingNamespace, extra_args: '--create-namespace'}}

            // Edit ingress-bot annotations
            if (ingressBotLabel in values.service.labels) {
                values.service.annotations[ingressBotHostAnnotation] = stagingHost
                message += `\n${parameters['release_name']}: https://${stagingHost}${values.service.annotations[ingressBotPathAnnotation]}`
            }

            createReleaseFiles(values, parameters)
        }

        core.setOutput('message', message)
        core.setOutput('staging_host', stagingHost)
        const labels = [`namespace: ${stagingNamespace}`]
        const issue_number = context.payload.number
        await octokit.issues.addLabels({owner, repo, labels, issue_number})

    }

    core.setOutput(outputName, releasePaths.join(' '))
    await artifactClient.uploadArtifact(outputName, releaseFiles, workspace)

}

main().catch(err => core.setFailed(err));