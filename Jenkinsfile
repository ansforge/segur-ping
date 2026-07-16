// Single pipeline triggered every minute, running on a labeled ANS agent
// (bookwormjdk17 — has git + Node 18). No Docker: the ping-segur agent has no
// docker binary, so we run the Node scripts directly on the agent.
//
//  - Every minute: ping all targets and append to docs/data/<day>.json (no git).
//  - Every 2h (or when PUBLISH_NOW=true): rebuild the site manifest, commit,
//    and push to main so GitHub Pages (Actions workflow) redeploys.
//
// Data durability: skipDefaultCheckout(true) means the per-minute build never
// re-checks-out and thus never wipes the uncommitted appended data in the
// persistent branch workspace. We clone once, then only commit/push at publish.

pipeline {
  agent { label 'bookwormjdk17' }

  triggers { cron('* * * * *') }

  options {
    disableConcurrentBuilds()          // skip a tick rather than overlap runs
    skipDefaultCheckout(true)          // never let checkout wipe uncommitted appended data
    buildDiscarder(logRotator(numToKeepStr: '200'))
    timeout(time: 5, unit: 'MINUTES')
  }

  parameters {
    booleanParam(name: 'PUBLISH_NOW', defaultValue: false, description: 'Force a publish on this run')
  }

  environment {
    BRANCH      = 'main'
    // Reuse the multibranch GitHub App credential (the one branch indexing uses).
    // Adjust the id here if it differs from what checkout scm is configured with.
    GIT_CRED_ID = 'ans-forge'
  }

  stages {
    stage('Ensure repo') {
      steps {
        script {
          // First build on this agent: populate the persistent workspace using the
          // multibranch SCM config (App credentials). Subsequent builds reuse it so
          // the in-progress daily JSON survives between runs.
          if (!fileExists('.git')) {
            checkout scm
          }
        }
        sh '''
          set -e
          git checkout -B "$BRANCH"
          git config user.email "michael.faurel@esante.gouv.fr"
          git config user.name  "segur-ping bot"
          node --version
        '''
      }
    }

    stage('Collect') {
      steps {
        sh 'node scripts/collect.js'
      }
    }

    stage('Publish') {
      when {
        expression {
          return params.PUBLISH_NOW || (sh(script: 'node scripts/is-publish-tick.js', returnStatus: true) == 0)
        }
      }
      steps {
        withCredentials([gitUsernamePassword(credentialsId: env.GIT_CRED_ID)]) {
          sh '''
            set -e
            node scripts/build-site.js
            git add docs/data
            if git diff --cached --quiet; then
              echo "No data changes to publish"
              exit 0
            fi
            git commit -m "data: publish $(date -Iseconds)"
            git pull --rebase origin "$BRANCH"
            git push origin HEAD:"$BRANCH"
          '''
        }
      }
    }
  }
}
