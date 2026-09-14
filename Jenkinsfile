pipeline {
    agent any
    stages {
           stage('SCM cloning') {
    steps {
            echo 'Server cloning..'
            sshagent(['github-ssh-key']) {
                sh """
                    echo "Starting cloning..."
                    mkdir -p test-1
                    cd test-1
                    echo "Cloning repository..."
                    git clone git@github.com:100CallsToEurop/test-1.git .
                    echo "Cloning complete."
                    rm -rf .git
                """
            }
    }
}
        stage('Deployment') {
            steps {
                script {
                        sh '/home/jenkinsuser/test1.run.sh'
                }
            }
        }
    }
}
