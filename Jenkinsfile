// Single pipeline triggered every minute.
//  - Every minute: ping all targets and append to docs/data/<day>.json (no git).
//  - Every 2h (or when PUBLISH_NOW=true): rebuild the site manifest, commit,
//    and push to GitHub so GitHub Pages updates.
//
// Requirements on the Jenkins side (see README):
//  - Docker available on the agent; image built once: `docker build -t segur-ping:latest .`
//  - Credential id `github-segur-ping` (GitHub username + PAT with repo push).
//  - Pipeline-from-SCM with "Lightweight checkout" enabled so fetching this
//    Jenkinsfile does NOT wipe the workspace (uncommitted data must survive).

pipeline {
  agent {
    docker {
      image 'segur-ping:latest'
      args '--cap-add=NET_RAW -u root:root'   // ICMP needs NET_RAW; root avoids uid mismatches
    }
  }

  triggers { cron('* * * * *') }

  options {
    disableConcurrentBuilds()          // skip a tick rather than overlap runs
    skipDefaultCheckout(true)          // never let checkout wipe uncommitted appended data
    buildDiscarder(logRotator(numToKeepStr: '500'))
    timeout(time: 5, unit: 'MINUTES')
  }

  parameters {
    booleanParam(name: 'PUBLISH_NOW', defaultValue: false, description: 'Force a publish on this run')
  }

  environment {
    BRANCH = 'main'
  }

  stages {
    stage('Ensure repo') {
      steps {
        withCredentials([usernamePassword(credentialsId: 'github-segur-ping',
                          usernameVariable: 'GH_USER', passwordVariable: 'GH_TOKEN')]) {
          sh '''
            set -e
            git config --global --add safe.directory "$PWD"
            AUTH_URL="https://${GH_USER}:${GH_TOKEN}@github.com/ansforge/segur-ping.git"
            if [ ! -d .git ]; then
              git clone "$AUTH_URL" .
            fi
            git remote set-url origin "$AUTH_URL"
            git config user.email "michael.faurel@esante.gouv.fr"
            git config user.name "segur-ping bot"
          '''
        }
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
