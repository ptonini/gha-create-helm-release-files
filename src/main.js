require('dotenv-expand').expand(require('dotenv').config())
const fs = require('fs');
const yaml = require('yaml');
const core = require('@actions/core');
const {context} = require('@actions/github')
const {Octokit} = require('@octokit/rest')
const artifact = require('@actions/artifact');


// Inputs
const environment = core.getInput('environment')
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
const {owner, repo} = context.repo
const repoFullName = context.payload.repository.full_name
const repoId = context.payload.repository.id
const workspace = process.env.GITHUB_WORKSPACE
const octokit = new Octokit({auth: githubToken})
const artifactClient = artifact.create()
const extraValuesVariable = 'extra_values'
const stagingGroupVariable = 'staging_group'
const releasesOutputName = 'releases'
const valuesFilename = 'values'
const parametersFilename = 'parameters'
const artifactFiles = []
const releasePaths = []


async function getManifests(owner, repo, repository_id, environment_name, ref) {

    let values, parameters, version
    core.debug(`fetching ${repoFullName} manifests`)

    try {
        // Fetch helm manifest
        const path = manifestFile
        const {data: {content: content}} = await octokit.rest.repos.getContent({owner, repo, ref, path})
        let manifestStr = Buffer.from(content, 'base64').toString('utf-8')
        // Parse manifest and extract values
        let manifest = yaml.parse(manifestStr)
        values = manifest.values
        delete manifest.values
        // Fetch extra values
        let name = extraValuesVariable
        try {
            const {data: {value: value}} = await octokit.rest.actions['getRepoVariable']({owner, repo, name})
            values = {...values, ...yaml.parse(value)}
        } catch (e) {
            core.warning(`${repo} repository extra values are unusable [${e}]`)
        }
        try {
            const {data: {value: value}} = await octokit.rest.actions['getEnvironmentVariable']({repository_id, environment_name, name})
            values = {...values, ...yaml.parse(value)}
        } catch (e) {
            core.warning(`${repo} environment extra values are unusable [${e}]`)
        }
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

    // Write values file
    core.debug(`writing ${releasePath}/${valuesFilename}`)
    fs.writeFileSync(`${releasePath}/${valuesFilename}`, JSON.stringify(values, null, 2));
    artifactFiles.push(`${releasePath}/${valuesFilename}`)

    // Write parameters file
    core.debug(`writing ${releasePath}/${parametersFilename}`)
    let fileContent = String()
    Object.keys(parameters).forEach(p => fileContent += `${p.toUpperCase()}=${parameters[p]}\n`)
    fs.writeFileSync(`${releasePath}/${parametersFilename}`, fileContent)
    artifactFiles.push(`${releasePath}/${parametersFilename}`)

}

async function main() {

    if (environment === "production") {

        // Prepare production deploy
        const {values, parameters, version} = await getManifests(owner, repo, repoId, environment)
        values.image = `${containerRegistry}/${repo}:${version}`
        createReleaseFiles(values, parameters)

    } else if (environment === "staging") {

        // Prepare staging deploy
        const stagingNamespace = `${repo.replaceAll('_', '-')}-${context.payload.number}`
        const stagingHost = `${stagingNamespace}.${stagingDomain}`
        const stagingReleases = []
        let message = `### Namespace\n${stagingNamespace}\n### Services\n`

        core.notice(`Namespace: ${stagingNamespace}`)

        // Create current repo release
        const {values, parameters, version} = await getManifests(owner, repo, repoId, environment, context.payload.pull_request?.head.ref)
        stagingReleases.push({values, parameters})
        values.image = digest ? `${containerRegistry}/${repo}@${digest}` : `${containerRegistry}/${repo}:${version}`

        // Fetch staging group members
        try {
            core.debug(`fetching ${repoFullName} staging group`)
            const name = stagingGroupVariable;
            const {data: {value: value}} = await octokit.rest.actions['getRepoVariable']({owner, repo, name})
            // for (const member of yaml.parse(value).filter(member => member !== repo)) {
            //     const {values, parameters, version} = await getManifests(owner, member)
            //     values.image = `${containerRegistry}/${member}:${version}`
            //     stagingReleases.push({values, parameters})
            // }
        } catch (e) {
            core.debug(`${repo} staging group is not usable [${e}]`)
        }

        // Save release files
        for (const {values, parameters} of stagingReleases) {
            const stagingParameters = {...parameters, ...{namespace: stagingNamespace, extra_args: '--create-namespace'}}
            // Edit ingress-bot annotations
            if ('service' in values && ingressBotLabel in values.service.labels) {
                values.service.annotations[ingressBotHostAnnotation] = stagingHost
                const line = `${parameters['release_name']}: https://${stagingHost}${values.service.annotations[ingressBotPathAnnotation]}`
                core.notice(line)
                message += `* ${line}\n`
            }
            createReleaseFiles(values, stagingParameters)
        }
        core.setOutput('message', message)
        core.setOutput('staging_host', stagingHost)
        await octokit.issues.addLabels({
            owner, repo, labels: [`namespace: ${stagingNamespace}`], issue_number: context.payload.number
        })

    } else core.setFailed(`unsupported environment: ${environment}`)

    core.setOutput(releasesOutputName, releasePaths.join(' '))
    await artifactClient.uploadArtifact(releasesOutputName, artifactFiles, workspace)

}

main().catch(err => core.setFailed(err));